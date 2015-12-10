#!/bin/sh

carton exec pp -M Mojolicious::Plugin::HeaderCondition -M Mojolicious::Plugin::TagHelpers -M Mojolicious::Plugin::DefaultHelpers -M Mojolicious::Plugin::EPLRenderer -M Mojolicious::Plugin::EPRenderer -M Mojolicious::Plugin::JSONConfig -a "local/lib/perl5/Mojolicious/Commands.pm;Mojolicious/Commands.pm"  -a "/home/ray/perl5/perlbrew/perls/perl-5.18.2/lib/5.18.2/Pod/Simple/TranscodeSmart.pm;Pod/Simple/TranscodeSmart.pm" mvw-server.pl -o mvw-server

