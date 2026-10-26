# The web suite's environment: the scenario image plus what serves FPP's web
# UI on a device -- Apache in front of php-fpm, configured the way
# configure_apache() in fpp's SD/FPP_Install.sh does it. The site config itself
# comes from the tree under test at startup (scripts/web_serve.py).
FROM fpp-tests-env

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        apache2 php8.4-fpm php8.4-cli php8.4-common php8.4-curl php8.4-bcmath \
        php8.4-sqlite3 php8.4-zip php8.4-xml \
        sudo jq file iputils-ping net-tools wget \
    && rm -rf /var/lib/apt/lists/*

RUN a2dismod mpm_prefork 2>/dev/null; \
    for mod in mpm_event http2 cgi rewrite expires proxy proxy_http proxy_http2 \
               proxy_html headers proxy_wstunnel proxy_fcgi setenvif; do \
        a2enmod -q "$mod" || exit 1; \
    done && a2enconf -q php8.4-fpm \
    && rm -f /etc/apache2/conf-enabled/other-vhosts-access-log.conf

# PHP as "FPP - Configuring PHP" in SD/FPP_Install.sh sets it up; the pages
# need short_open_tag at the least.
RUN for f in /etc/php/8.4/cli/php.ini /etc/php/8.4/fpm/php.ini; do \
        sed -i -e "s/^short_open_tag.*/short_open_tag = On/" \
               -e "s/max_execution_time.*/max_execution_time = 1000/" \
               -e "s/max_input_time.*/max_input_time = 900/" \
               -e "s/default_socket_timeout.*/default_socket_timeout = 900/" \
               -e "s/post_max_size.*/post_max_size = 1999M/" \
               -e "s/upload_max_filesize.*/upload_max_filesize = 1999M/" \
               -e "s/;upload_tmp_dir =.*/upload_tmp_dir = \/home\/fpp\/media\/upload/" \
               -e "s/^;max_input_vars.*/max_input_vars = 5000/" \
               -e "s/^output_buffering.*/output_buffering = 1024/" "$f" || exit 1; \
    done

# php-fpm runs as root: fppd does, and the pages edit what it writes (the
# settings file, playlists) and run the same sudo commands as on a device,
# where the fpp user has passwordless sudo.
RUN sed -i -e 's/^user = .*/user = root/' -e 's/^group = .*/group = root/' \
           -e 's/^pm.max_children.*/pm.max_children = 25/' \
           -e 's/^;clear_env.*/clear_env = no/' \
        /etc/php/8.4/fpm/pool.d/www.conf

RUN echo "ServerName localhost" > /etc/apache2/conf-enabled/servername.conf
