#!/bin/bash

pp server/mspproxy.fpl -M MLDBM::Serializer::Storable -o server/mspproxy.fpl.bin
carton exec pp -M Mojolicious::Plugin::HeaderCondition \
		-M Mojolicious::Plugin::TagHelpers \
		-M Mojolicious::Plugin::DefaultHelpers \
		-M Mojolicious::Plugin::EPLRenderer \
		-M Mojolicious::Plugin::EPRenderer \
		-M Mojolicious::Plugin::JSONConfig \
		-M MLDBM::Serializer::Storable \
		-a "local/lib/perl5/Mojolicious/Commands.pm;Mojolicious/Commands.pm" \
		-a "/home/ray/perl5/perlbrew/perls/perl-5.18.2/lib/5.18.2/Pod/Simple/TranscodeSmart.pm;Pod/Simple/TranscodeSmart.pm" \
		-a "/home/ray/perl5/perlbrew/perls/perl-5.18.2/lib/5.18.2/utf8_heavy.pl;utf8_heavy.pl" \
		-a "/home/ray/perl5/perlbrew/perls/perl-5.18.2/lib/5.18.2/unicore;unicore" \
	server/mvw-server.pl -o server/mvw-server

