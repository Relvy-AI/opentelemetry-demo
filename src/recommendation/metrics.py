#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

def init_metrics(meter):

    # Recommendations counter
    app_recommendations_counter = meter.create_counter(
        'app_recommendations_counter', unit='recommendations', description="Counts the total number of given recommendations"
    )

    # Cache hit counter
    app_cache_hits_counter = meter.create_counter(
        'app_cache_hits_counter', unit='hits', description="Counts the number of cache hits"
    )

    # Cache miss counter
    app_cache_misses_counter = meter.create_counter(
        'app_cache_misses_counter', unit='misses', description="Counts the number of cache misses"
    )

    # Cache size gauge
    app_cache_size_gauge = meter.create_gauge(
        'app_cache_size_gauge', unit='entries', description="Current number of entries in the cache"
    )

    rec_svc_metrics = {
        "app_recommendations_counter": app_recommendations_counter,
        "app_cache_hits_counter": app_cache_hits_counter,
        "app_cache_misses_counter": app_cache_misses_counter,
        "app_cache_size_gauge": app_cache_size_gauge,
    }

    return rec_svc_metrics