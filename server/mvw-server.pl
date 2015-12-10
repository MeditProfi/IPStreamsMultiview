#!/usr/bin/env perl
use utf8;

use FindBin qw($Bin);
use File::Spec;
BEGIN {
	if ($ENV{'PAR_TEMP'}) {
		my $dir = File::Spec->catfile ($ENV{'PAR_TEMP'}, 'inc');
		chdir $dir or die "chdir: '$dir': $!";
	}
}

use Mojolicious::Lite;
use Mojo::Server::Prefork;

use Fcntl;
use MLDBM::Sync;
use MLDBM qw(MLDBM::Sync::SDBM_File Storable);
use XML::Ximple qw(parse_xml ximple_to_string);
use URI::Escape;
use Socket qw(inet_aton inet_ntoa);

my %CLIENTS = ();
my %RTMP_DATA = ();
my $UA;
my %DB;
my $DBh;

use constant DEFAULT_TIMEOUT => 1;
use constant OUT_OF_SPACE_SLOT => -1;

init_app();
init_db();
init_call_map();
init_loop();

Mojo::Server::Prefork->new(app => app, listen => app->config->{MVWServer}{Listen})->run;

sub init_app {
	plugin('JSONConfig', {file => "$Bin/mvw-server.json"});
	app->log->path("$Bin/log/" . app->mode . '.log');
	$UA = Mojo::UserAgent->new;
	$DBh = tie %DB, 'MLDBM::Sync', "$Bin/.mvw-server.db", O_CREAT|O_RDWR, 0640
		or die "Can't tie database: $!";
}

sub init_db {
	$DB{rtmp_data_string} = '';
	$DB{rtmp_data} = {};
	$DB{streams} = {};
	$DB{busy_slots} = {};
	$DB{next_update_time} = { server => time, clients => {} };
}

sub init_call_map {
	websocket '/stat' => sub {
		add_client_connection(@_);
	};
	get '/stat' => sub {
		my $self = shift;
		return $self->render(text => rtmp_info(), format => 'xml');
	};
	get '/refresh_slots_data' => sub {
		refresh_slots_data(@_);
	};
	get '/onair' => sub {
		process_inputs_onair_request(@_);
	};
	get '/select' => sub {
		process_inputs_select_request(@_);
	};
	get '/publish' => sub {
		process_rtmp_onpublish_request(@_);
	};
}

sub init_loop {
	Mojo::IOLoop->recurring(0.25 => sub {
		update_rtmp_data();
		send_data_to_clients();
	});
}

sub add_client_connection {
	my $self = shift;

	app->log->debug(sprintf 'Client connected: %s', $self->tx);
	my $id = sprintf "%s", $self->tx;
	$CLIENTS{$id} = $self->tx;
	set_client_update_time($id, time);

	$self->on(message => sub {
		my ($self, $msg) = @_;

		$self->tx->send(rtmp_info())
			if $msg eq 'info';
	});

	$self->on(finish => sub {
		app->log->debug('Client disconnected');
		delete $CLIENTS{$id};
		set_client_update_time($id, undef);
	});
}

sub update_rtmp_data {
	my $options = shift // {};
	if(!$options->{force}) {
		my $time_has_come = atomic_check_and_increase_update_time();
		return
			unless $time_has_come;
	}
	$options->{use_cached_data} ? set_rtmp_data_from_cache() : get_and_parse_rtmp_data();
	assign_slots();
	save_rtmp_data();
}

sub save_rtmp_data {
	my $rtmp_data_as_ximple_tree = rtmp_data_as_ximple_tree();
	$DB{rtmp_data_string} = ximple_to_string($rtmp_data_as_ximple_tree);
}

sub atomic_check_and_increase_update_time {
	my $client_id = shift // '';

	$DBh->Lock;
	my $update_time_structure = $DB{next_update_time};
	my $next_update_time = ($client_id eq '') ?
		$update_time_structure->{server} : ($update_time_structure->{clients}{$client_id} // time);
	if(time < $next_update_time) {
		$DBh->UnLock;
		return 0;
	}
	my $new_next_update_time = time + app->config->{MVWServer}{ClientUpdateInterval};
	if($client_id eq '') {
		$update_time_structure->{server} = $new_next_update_time;
	} else {
		$update_time_structure->{clients}{$client_id} = $new_next_update_time;
	}
	$DB{next_update_time} = $update_time_structure;
	$DBh->UnLock;

	return 1;
}

sub send_data_to_clients {
	for my $c_id (keys %CLIENTS) {
		my $time_has_come = atomic_check_and_increase_update_time($c_id);
		next
			unless $time_has_come;
		$CLIENTS{$c_id}->send(rtmp_info());
	}
}

sub get_and_parse_rtmp_data {
	%RTMP_DATA = ();
	my $config = app->config->{Servers};
	for my $addr (keys %$config) {
		my $srv_data = $config->{$addr};
		my $protocol = $srv_data->{Protocol} // 'http';
		my $stat_addr = "$protocol://$addr/$srv_data->{Stat}";
		$UA->connect_timeout($srv_data->{Timeout} // DEFAULT_TIMEOUT);
		my $tx = $UA->get($stat_addr);
		my $res = $tx->success;
		if(!$res) {
			my $err = $tx->error;
			app->log->error("Can't get stat from $stat_addr: $err->{message}" .
				(defined($err->{code}) ? " ($err->{code})" : ''));
			next;
		}
		my $content = $res->body;
		my $srv_streams = parse_rtmp_data({server_addr => $addr, content => $content});
		next
			unless %$srv_streams;
		update_server_data($addr, $srv_streams);
	}
	$DB{rtmp_data} = \%RTMP_DATA;
}

sub set_rtmp_data_from_cache {
	%RTMP_DATA = %{$DB{rtmp_data}};
}

sub parse_rtmp_data {
	my $params = shift;
	my ($server_addr, $text_data) = ($params->{server_addr}, $params->{content});
	my %rtmp_data = ();
	my $applications = find_by_tag_name({xml_tree => {content => parse_xml($text_data)}, tag_name => 'application'});
	for my $app (@$applications) {
		my $name_node = find_by_tag_name({xml_tree => $app, tag_name => 'name'}, find_first => 1, no_recursion => 1)->[0];
		my $app_name = get_node_value($name_node);
		next
			if is_unknown_app({srv => $server_addr, app => $app_name});
		my %app_data = ();
		my $streams = find_by_tag_name({xml_tree => $app, tag_name => 'stream'});
		for my $stream (@$streams) {
			my $is_active = find_by_tag_name({xml_tree => $stream, tag_name => 'active'});
			next
				unless @$is_active;
			my $stream_data = [];
			my $stream_name = '';
			for my $tag_name ('name', 'time', 'publishing') {
				my $node = find_by_tag_name({xml_tree => $stream, tag_name => $tag_name, find_first => 1}, no_recursion => 1)->[0];
				next
					unless $node;
				push @$stream_data, $node;
				$stream_name = get_node_value($node)
					if $tag_name eq 'name';
			}
			next
				if is_unknown_stream({srv => $server_addr, app => $app_name, stream => $stream_name});
			$app_data{$stream_name} = $stream_data;
		}
		next
			unless %app_data;
		$rtmp_data{$app_name} = \%app_data
	}
	return \%rtmp_data;
}

sub is_unknown_app {
	my $key = shift;
	my $server_apps_config = app->config->{Servers}{$key->{srv}}{Apps};
	return defined($server_apps_config->{$key->{app}}) ? 0 : 1;
}

sub is_unknown_stream {
	my $key = shift;
	my ($srv, $app, $stream) = ($key->{srv}, $key->{app}, $key->{stream});
	$stream =~ s/\@.+$//;
	my $app_streams_config = app->config->{Servers}{$srv}{Apps}{$app}{Streams};
	return (defined($app_streams_config->{$stream}) ? 0 : 1)
		if defined($app_streams_config);
	my $zone = _get_stream_zone($key);
	my $zone_info = app->config->{Zones}{$zone};
	return ($zone_info and $zone_info->{Slots}) ? 0 : 1;
}

sub _get_stream_zone {
	my $key = shift;
	return app->config->{Servers}{$key->{srv}}{Apps}{$key->{app}}{Zone};
}

sub rtmp_data_as_ximple_tree {
	my %application_nodes = ();
	my @server_nodes = ();
	for my $server_addr (keys %RTMP_DATA) {
		push @server_nodes, {
			tag_name => 'server', attrib => {addr => $server_addr},
			content => get_application_nodes($RTMP_DATA{$server_addr})
		};
	}
	my $rtmp_node = {tag_name => 'rtmp', content => \@server_nodes};
	return [$rtmp_node];
}

sub get_application_nodes {
	my $app_data = shift;
	my %app_nodes = ();
	for my $app_name (keys %$app_data) {
		my $live_node;
		if(!defined($app_nodes{$app_name})) {
			my $app_name_node = {tag_name => 'name', content => [ $app_name ]};
			$live_node = {tag_name => 'live', content => []}; 
			$app_nodes{$app_name} = {tag_name => 'application', content => [$app_name_node, $live_node]}
		} else {
			$live_node = $app_nodes{$app_name}{content}[1];
		}
		for my $stream_data (values %{$app_data->{$app_name}}) {
			push @{$live_node->{content}}, {tag_name => 'stream', content => $stream_data};
		}
	}
	my @res = ();
	for my $app_node (values %app_nodes) {
		push @res, $app_node
			if @{$app_node->{content}[1]{content}};
	}
	return \@res;
}

sub find_by_tag_name {
	my $params = shift;

	my $xml_tree = $params->{xml_tree};
	my $tag_name = $params->{tag_name};
	my $find_first = $params->{find_first};
	my $stop_recursion = $params->{no_recursion} // 0;

	my $content = $xml_tree->{content};
	return ''
		unless defined($content) and ref($content) eq 'ARRAY';

	my @res = ();
	for my $subtree (@$content) {
		next
			unless ref($subtree) eq 'HASH';
		my $current_tag_name = $subtree->{tag_name};
		if($current_tag_name eq $tag_name) {
			push @res, $subtree;
			$stop_recursion = 1;
		} elsif(!$stop_recursion) {
			my $subtree_content = find_by_tag_name({xml_tree => $subtree, tag_name => $tag_name, find_first => $find_first});
			next
				unless $subtree_content;
			push @res, @$subtree_content;
		}
		last
			if $find_first and scalar(@res) >= 1;
	}
	return \@res;
}

sub get_node_value {
	my $node = shift;
	return ref($node->{content})  eq 'ARRAY' ? join('', @{$node->{content}}) : $node->{content};
}

sub assign_slots {
	$DBh->Lock();
	_cleanup_db();
	for my $srv_addr (keys %RTMP_DATA) {
		_assign_app_slots($srv_addr);
	}
	$DBh->UnLock();
}

sub _assign_app_slots {
	my $srv_addr = shift;

	my $apps = $RTMP_DATA{$srv_addr};
	for my $app_id (keys %$apps) {
		_assign_stream_slots($srv_addr, $app_id);
	}
}

sub _assign_stream_slots {
	my ($srv_addr, $app_id) = @_;

	my $app = $RTMP_DATA{$srv_addr}{$app_id};
	for my $stream_name (keys %$app) {
		my $slot = $DB{streams}{"$srv_addr/$app_id/$stream_name"} //
			_assign_new_slot({srv => $srv_addr, app => $app_id, stream => $stream_name});
		my %slot_node = (tag_name => 'slot', content => [ $slot ], attrib => {});
		$slot_node{attrib}{selected} = 1
			if $DB{selected_slots} and $DB{selected_slots}->{$slot};
		$slot_node{attrib}{onair} = 1
			if $DB{onair_slots} and $DB{onair_slots}->{$slot};
		push @{$app->{$stream_name}}, \%slot_node;
	}
}

sub _assign_new_slot {
	my $key = shift;
	my $slot = _get_explicit_slot($key) // _get_next_free_slot($key);
	return $slot
		if $slot == OUT_OF_SPACE_SLOT;
	my $streams = $DB{streams};
	$streams->{"$key->{srv}/$key->{app}/$key->{stream}"} = $slot;
	$DB{streams} = $streams;
	my $busy_slots = $DB{busy_slots};
	$busy_slots->{$slot} = 1;
	$DB{busy_slots} = $busy_slots;
	return $slot;
}

sub _get_explicit_slot {
	my $key = shift;
	my $streams_map = app->config->{Servers}{$key->{srv}}{Apps}{$key->{app}}{Streams};
	return undef
		unless $streams_map;
	(my $stream_key = $key->{stream}) =~ s/\@.+$//;
	return $streams_map->{$stream_key};
}

sub _get_next_free_slot {
	my $key = shift;
	my $zone = _get_stream_zone($key);
	my $zone_info = app->config->{Zones}{$zone};
	for my $slot_info (@{$zone_info->{Slots}}) {
		my $slot = $slot_info->{Pos};
		return $slot
			unless $DB{busy_slots}{$slot};
	}
	return OUT_OF_SPACE_SLOT;
}

sub _cleanup_db {
	my @db_keys = keys %{$DB{streams}};
	for my $key (@db_keys) {
		my ($srv_addr, $app_id, $stream_name) = split('/', $key);
		next
			if defined($RTMP_DATA{$srv_addr}) and
				defined($RTMP_DATA{$srv_addr}{$app_id}) and 
				defined($RTMP_DATA{$srv_addr}{$app_id}{$stream_name});
		my $slot = $DB{streams}{$key};
		my $streams = $DB{streams};
		delete $streams->{$key};
		$DB{streams} = $streams;
		my $busy_slots = $DB{busy_slots};
		delete $busy_slots->{$slot};
		$DB{busy_slots} = $busy_slots;
	}
}

sub update_server_data {
	my $server_addr = shift;
	my $new_data = shift;

	my $current_data = $RTMP_DATA{$server_addr} // {};
	for my $app_id (keys %$new_data) {
		$current_data->{$app_id} = {}
			unless defined($current_data->{$app_id});
		for my $stream_id (keys %{$new_data->{$app_id}}) {
			$current_data->{$app_id}{$stream_id} = $new_data->{$app_id}{$stream_id};
		}
	}

	$RTMP_DATA{$server_addr} = $current_data;
}

sub rtmp_info {
	return $DB{rtmp_data_string};
}

sub refresh_slots_data {
	my $self = shift;
	init_db();
	return $self->render(text => 'OK');
}

sub process_inputs_select_request {
	my $self = shift;
	my $selected_slots = $self->every_param('slot');
	$DB{selected_slots} = { map { $_ => 1} @$selected_slots };
	update_rtmp_data({use_cached_data => 1, force => 1});
	set_clients_update_time(time);
	return $self->render(text => 'OK');
}

sub set_clients_update_time {
	my $time = shift;
	$DBh->Lock();
	my $update_time_structure = $DB{next_update_time};
	for my $id (keys %{$update_time_structure->{clients}}) {
		$update_time_structure->{clients}{$id} = 0;
	}
	$DB{next_update_time} = $update_time_structure;
	$DBh->UnLock();
}

sub set_client_update_time {
	my $id = shift;
	my $time = shift;

	$DBh->Lock();
	my $update_time_structure = $DB{next_update_time};
	if(defined($time)) {
		$update_time_structure->{clients}{$id} = $time;
	} else {
		delete $update_time_structure->{clients}{$id};
	}
	$DB{next_update_time} = $update_time_structure;
	$DBh->UnLock();
}

sub process_inputs_onair_request {
	my $self = shift;
	my $onair_slots = $self->every_param('slot');
	$DB{onair_slots} = { map { $_ => 1} @$onair_slots };
	update_rtmp_data({use_cached_data => 1, force => 1});
	set_clients_update_time(time);
	return $self->render(text => 'OK');
}

sub process_rtmp_onpublish_request {
	my $self = shift;

	my $name = uri_unescape(scalar($self->param('name')));
	return $self->render(text => '')
		unless ($name =~ s/\@(\w+)$//);

	my $new_app = $1;
	my $app = $self->param('app');
	my $tcurl = $self->param('tcurl');

	$tcurl =~ m"rtmp://(.+?)(?:\:.+)?/";
	my $addr_name = $1;
	my $addr_ip = inet_ntoa(inet_aton($addr_name));
	$tcurl =~ s|$addr_name|$addr_ip|;
	$tcurl =~ s/\/$//;
	$tcurl =~ s"/$app(\?|$)"/$new_app$1";
	$self->res->code(301);
	return $self->redirect_to("$tcurl/$name");
}
