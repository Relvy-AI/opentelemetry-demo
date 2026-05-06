#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0


# Python
import os
import random
import threading
import time
from concurrent import futures

# Pip
import grpc
from opentelemetry import trace, metrics
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import (
    OTLPLogExporter,
)
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource

from openfeature import api
from openfeature.contrib.provider.flagd import FlagdProvider

from openfeature.contrib.hook.opentelemetry import TracingHook

# Local
import logging
import demo_pb2
import demo_pb2_grpc
from grpc_health.v1 import health_pb2
from grpc_health.v1 import health_pb2_grpc

from metrics import (
    init_metrics
)
from cache import init_cache, get_cache

cached_ids = []
first_run = True
cache_cleanup_thread = None
stop_cleanup = threading.Event()


class RecommendationService(demo_pb2_grpc.RecommendationServiceServicer):
    def ListRecommendations(self, request, context):
        prod_list = get_product_list(request.product_ids)
        span = trace.get_current_span()
        span.set_attribute("app.products_recommended.count", len(prod_list))
        logger.info(f"Receive ListRecommendations for product ids:{prod_list}")

        # build and return response
        response = demo_pb2.ListRecommendationsResponse()
        response.product_ids.extend(prod_list)

        # Collect metrics for this service
        rec_svc_metrics["app_recommendations_counter"].add(len(prod_list), {'recommendation.type': 'catalog'})

        return response

    def Check(self, request, context):
        return health_pb2.HealthCheckResponse(
            status=health_pb2.HealthCheckResponse.SERVING)

    def Watch(self, request, context):
        return health_pb2.HealthCheckResponse(
            status=health_pb2.HealthCheckResponse.UNIMPLEMENTED)


def cache_cleanup_worker():
    """Background worker to clean up expired cache entries and update metrics."""
    logger.info("Cache cleanup worker started")
    
    while not stop_cleanup.is_set():
        try:
            cache = get_cache()
            if cache:
                # Clean up expired entries
                expired_count = cache.cleanup_expired()
                if expired_count > 0:
                    logger.debug(f"Cleaned up {expired_count} expired cache entries")
                
                # Update cache size metric
                stats = cache.stats()
                rec_svc_metrics["app_cache_size_gauge"].set(stats["active_entries"])
            
        except Exception as e:
            logger.error(f"Error in cache cleanup worker: {e}")
        
        # Wait for 60 seconds or until stop signal
        stop_cleanup.wait(60)
    
    logger.info("Cache cleanup worker stopped")


def get_product_list(request_product_ids):
    global first_run
    global cached_ids
    with tracer.start_as_current_span("get_product_list") as span:
        max_responses = 5
        cache = get_cache()

        # Formulate the list of characters to list of strings
        request_product_ids_str = ''.join(request_product_ids)
        request_product_ids = request_product_ids_str.split(',')

        # Create cache key based on request (for more specific caching)
        cache_key = f"products_list"
        
        product_ids = None
        cache_hit = False

        # Feature flag scenario - Cache Leak (legacy behavior)
        if check_feature_flag("recommendationCacheFailure"):
            span.set_attribute("app.recommendation.cache_enabled", True)
            if random.random() < 0.5 or first_run:
                first_run = False
                span.set_attribute("app.cache_hit", False)
                logger.info("get_product_list: cache miss (feature flag)")
                cat_response = product_catalog_stub.ListProducts(demo_pb2.Empty())
                response_ids = [x.id for x in cat_response.products]
                cached_ids = cached_ids + response_ids
                cached_ids = cached_ids + cached_ids[:len(cached_ids) // 4]
                product_ids = cached_ids
            else:
                span.set_attribute("app.cache_hit", True)
                logger.info("get_product_list: cache hit (feature flag)")
                product_ids = cached_ids
        else:
            # Use new cache implementation
            span.set_attribute("app.recommendation.cache_enabled", True)
            
            # Try to get from cache first
            if cache:
                product_ids = cache.get(cache_key)
                if product_ids:
                    cache_hit = True
                    span.set_attribute("app.cache_hit", True)
                    logger.info("get_product_list: cache hit")
                    
                    # Update cache metrics
                    rec_svc_metrics["app_cache_hits_counter"].add(1)
                else:
                    span.set_attribute("app.cache_hit", False)
                    logger.info("get_product_list: cache miss")
                    
                    # Update cache metrics
                    rec_svc_metrics["app_cache_misses_counter"].add(1)

            # If not in cache, fetch from product catalog service
            if not cache_hit:
                cat_response = product_catalog_stub.ListProducts(demo_pb2.Empty())
                product_ids = [x.id for x in cat_response.products]
                
                # Store in cache if cache is available
                if cache:
                    cache.put(cache_key, product_ids)
                    logger.debug(f"Stored {len(product_ids)} products in cache")

        span.set_attribute("app.products.count", len(product_ids))

        # Create a filtered list of products excluding the products received as input
        filtered_products = list(set(product_ids) - set(request_product_ids))
        num_products = len(filtered_products)
        span.set_attribute("app.filtered_products.count", num_products)
        num_return = min(max_responses, num_products)

        # Sample list of indicies to return
        indices = random.sample(range(num_products), num_return)
        # Fetch product ids from indices
        prod_list = [filtered_products[i] for i in indices]

        span.set_attribute("app.filtered_products.list", prod_list)

        return prod_list


def must_map_env(key: str):
    value = os.environ.get(key)
    if value is None:
        raise Exception(f'{key} environment variable must be set')
    return value


def get_env_int(key: str, default: int) -> int:
    """Get an integer environment variable with a default value."""
    try:
        value = os.environ.get(key)
        return int(value) if value is not None else default
    except ValueError:
        logger.warning(f"Invalid integer value for {key}, using default: {default}")
        return default


def check_feature_flag(flag_name: str):
    # Initialize OpenFeature
    client = api.get_client()
    return client.get_boolean_value("recommendationCacheFailure", False)


if __name__ == "__main__":
    service_name = must_map_env('OTEL_SERVICE_NAME')
    api.set_provider(FlagdProvider(host=os.environ.get('FLAGD_HOST', 'flagd'), port=os.environ.get('FLAGD_PORT', 8013)))
    api.add_hooks([TracingHook()])

    # Initialize Traces and Metrics
    tracer = trace.get_tracer_provider().get_tracer(service_name)
    meter = metrics.get_meter_provider().get_meter(service_name)
    rec_svc_metrics = init_metrics(meter)

    # Initialize Cache with configuration from environment variables
    cache_max_size = get_env_int('RECOMMENDATION_CACHE_MAX_SIZE', 1000)
    cache_ttl = get_env_int('RECOMMENDATION_CACHE_TTL', 300)  # 5 minutes default
    
    cache = init_cache(max_size=cache_max_size, default_ttl=cache_ttl)

    # Initialize Logs
    logger_provider = LoggerProvider(
        resource=Resource.create(
            {
                'service.name': service_name,
            }
        ),
    )
    set_logger_provider(logger_provider)
    log_exporter = OTLPLogExporter(insecure=True)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))
    handler = LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider)

    # Attach OTLP handler to logger
    logger = logging.getLogger('main')
    logger.addHandler(handler)
    
    logger.info(f"Cache initialized with max_size={cache_max_size}, ttl={cache_ttl}")

    # Start cache cleanup worker thread
    cache_cleanup_thread = threading.Thread(target=cache_cleanup_worker, daemon=True)
    cache_cleanup_thread.start()

    catalog_addr = must_map_env('PRODUCT_CATALOG_ADDR')
    pc_channel = grpc.insecure_channel(catalog_addr)
    product_catalog_stub = demo_pb2_grpc.ProductCatalogServiceStub(pc_channel)

    # Create gRPC server
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))

    # Add class to gRPC server
    service = RecommendationService()
    demo_pb2_grpc.add_RecommendationServiceServicer_to_server(service, server)
    health_pb2_grpc.add_HealthServicer_to_server(service, server)

    # Start server
    port = must_map_env('RECOMMENDATION_PORT')
    server.add_insecure_port(f'[::]:{port}')
    server.start()
    logger.info(f'Recommendation service started, listening on port {port}')
    
    try:
        server.wait_for_termination()
    finally:
        # Signal cleanup thread to stop
        stop_cleanup.set()
        if cache_cleanup_thread:
            cache_cleanup_thread.join(timeout=5)
        logger.info("Service shutdown complete")