#!/usr/bin/env python3

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""
Simple test script for the in-memory cache implementation.
This can be run to verify the cache functionality.
"""

import time
import threading
from cache import InMemoryCache


def test_basic_operations():
    """Test basic cache operations."""
    print("Testing basic cache operations...")
    
    cache = InMemoryCache(max_size=3, default_ttl=2)
    
    # Test put and get
    cache.put("key1", "value1")
    assert cache.get("key1") == "value1", "Basic put/get failed"
    
    # Test cache miss
    assert cache.get("nonexistent") is None, "Cache miss should return None"
    
    print("✓ Basic operations test passed")


def test_ttl_expiration():
    """Test TTL expiration."""
    print("Testing TTL expiration...")
    
    cache = InMemoryCache(max_size=10, default_ttl=1)
    
    cache.put("key1", "value1", ttl=1)
    assert cache.get("key1") == "value1", "Value should exist before expiration"
    
    time.sleep(1.1)  # Wait for expiration
    assert cache.get("key1") is None, "Value should be None after expiration"
    
    print("✓ TTL expiration test passed")


def test_max_size_eviction():
    """Test LRU eviction when max size is reached."""
    print("Testing max size eviction...")
    
    cache = InMemoryCache(max_size=2, default_ttl=10)
    
    cache.put("key1", "value1")
    cache.put("key2", "value2")
    cache.put("key3", "value3")  # Should evict key1
    
    assert cache.get("key1") is None, "key1 should be evicted"
    assert cache.get("key2") == "value2", "key2 should still exist"
    assert cache.get("key3") == "value3", "key3 should exist"
    
    print("✓ Max size eviction test passed")


def test_lru_behavior():
    """Test LRU (Least Recently Used) behavior."""
    print("Testing LRU behavior...")
    
    cache = InMemoryCache(max_size=2, default_ttl=10)
    
    cache.put("key1", "value1")
    cache.put("key2", "value2")
    
    # Access key1 to make it recently used
    cache.get("key1")
    
    # Add key3, should evict key2 (least recently used)
    cache.put("key3", "value3")
    
    assert cache.get("key1") == "value1", "key1 should still exist (recently used)"
    assert cache.get("key2") is None, "key2 should be evicted (least recently used)"
    assert cache.get("key3") == "value3", "key3 should exist"
    
    print("✓ LRU behavior test passed")


def test_cleanup():
    """Test cleanup of expired entries."""
    print("Testing cleanup of expired entries...")
    
    cache = InMemoryCache(max_size=10, default_ttl=1)
    
    cache.put("key1", "value1", ttl=1)
    cache.put("key2", "value2", ttl=2)
    cache.put("key3", "value3", ttl=3)
    
    time.sleep(1.1)  # key1 should expire
    
    expired_count = cache.cleanup_expired()
    assert expired_count == 1, f"Should have cleaned up 1 entry, got {expired_count}"
    
    assert cache.get("key1") is None, "key1 should be gone after cleanup"
    assert cache.get("key2") == "value2", "key2 should still exist"
    assert cache.get("key3") == "value3", "key3 should still exist"
    
    print("✓ Cleanup test passed")


def test_thread_safety():
    """Test thread safety of cache operations."""
    print("Testing thread safety...")
    
    cache = InMemoryCache(max_size=100, default_ttl=10)
    errors = []
    
    def worker(worker_id):
        try:
            for i in range(50):
                key = f"worker{worker_id}_key{i}"
                value = f"worker{worker_id}_value{i}"
                
                cache.put(key, value)
                retrieved_value = cache.get(key)
                
                if retrieved_value != value:
                    errors.append(f"Worker {worker_id}: Expected {value}, got {retrieved_value}")
        except Exception as e:
            errors.append(f"Worker {worker_id}: Exception {e}")
    
    # Start multiple threads
    threads = []
    for i in range(5):
        t = threading.Thread(target=worker, args=(i,))
        threads.append(t)
        t.start()
    
    # Wait for all threads to complete
    for t in threads:
        t.join()
    
    assert len(errors) == 0, f"Thread safety errors: {errors}"
    
    print("✓ Thread safety test passed")


def test_stats():
    """Test cache statistics."""
    print("Testing cache statistics...")
    
    cache = InMemoryCache(max_size=10, default_ttl=2)
    
    cache.put("key1", "value1", ttl=1)
    cache.put("key2", "value2", ttl=3)
    
    stats = cache.stats()
    assert stats["size"] == 2, f"Expected size 2, got {stats['size']}"
    assert stats["max_size"] == 10, f"Expected max_size 10, got {stats['max_size']}"
    
    time.sleep(1.1)  # key1 should expire
    
    stats = cache.stats()
    assert stats["expired_entries"] == 1, f"Expected 1 expired entry, got {stats['expired_entries']}"
    assert stats["active_entries"] == 1, f"Expected 1 active entry, got {stats['active_entries']}"
    
    print("✓ Stats test passed")


def main():
    """Run all tests."""
    print("Starting cache tests...\n")
    
    try:
        test_basic_operations()
        test_ttl_expiration()
        test_max_size_eviction()
        test_lru_behavior()
        test_cleanup()
        test_thread_safety()
        test_stats()
        
        print("\n🎉 All tests passed!")
        
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        raise


if __name__ == "__main__":
    main()