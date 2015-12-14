#!/bin/sh

su -s /bin/sh -c "MOJO_MODE=production /srv/www/multiview/server/mvw-server >/dev/null 2>&1" nginx
