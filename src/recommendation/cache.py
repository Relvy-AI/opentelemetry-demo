#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

import time
import threading
from collections import OrderedDict
from typing import Any, Optional
import logging

logger = logging.getLogger(__name__)


class CacheEntry:
    """Represents a single cache entry with value and expiration time."""
    
    def __init__(self, value: Any, ttl: int):
        self.value = value
        self.expiry_time = time.time() + ttl
        
    def is_expired(self) -> bool:
        """Check if the cache entry has expired."""
        return time.time() > self.expiry_time


class InMemoryCache:
    """
    Thread-safe in-memory cache with TTL (Time To Live) and maximum size limit.
    Uses LRU (Least Recently Used) eviction policy when max size is reached.
    """
    
    def __init__(self, max_size: int = 1000, default_ttl: int = 300):
        """
        Initialize the cache.
        
        Args:
            max_size: Maximum number of entries in the cache
            default_ttl: Default time to live in seconds
        """
        self.max_size = max_size
        self.default_ttl = default_ttl
        self._cache = OrderedDict()  # Using OrderedDict for LRU behavior
        self._lock = threading.RLock()  # Reentrant lock for thread safety
        
        logger.info(f"Initialized cache with max_size={max_size}, default_ttl={default_ttl}")
    
    def get(self, key: str) -> Optional[Any]:
        """
        Get a value from the cache.
        
        Args:
            key: The cache key
            
        Returns:
            The cached value if it exists and hasn't expired, None otherwise
        """
        with self._lock:
            entry = self._cache.get(key)
            
            if entry is None:
                logger.debug(f"Cache miss for key: {key}")
                return None
                
            if entry.is_expired():
                logger.debug(f"Cache entry expired for key: {key}")
                del self._cache[key]
                return None
            
            # Move to end (mark as recently used)
            self._cache.move_to_end(key)
            logger.debug(f"Cache hit for key: {key}")
            return entry.value
    
    def put(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        """
        Put a value in the cache.
        
        Args:
            key: The cache key
            value: The value to cache
            ttl: Time to live in seconds (uses default if None)
        """
        if ttl is None:
            ttl = self.default_ttl
            
        with self._lock:
            # Remove existing entry if present
            if key in self._cache:
                del self._cache[key]
            
            # Check if we need to evict entries
            while len(self._cache) >= self.max_size:
                # Remove least recently used item
                oldest_key, _ = self._cache.popitem(last=False)
                logger.debug(f"Evicted cache entry for key: {oldest_key}")
            
            # Add new entry
            self._cache[key] = CacheEntry(value, ttl)
            logger.debug(f"Cached value for key: {key}, ttl: {ttl}")
    
    def delete(self, key: str) -> bool:
        """
        Delete a key from the cache.
        
        Args:
            key: The cache key
            
        Returns:
            True if the key was found and deleted, False otherwise
        """
        with self._lock:
            if key in self._cache:
                del self._cache[key]
                logger.debug(f"Deleted cache entry for key: {key}")
                return True
            return False
    
    def clear(self) -> None:
        """Clear all entries from the cache."""
        with self._lock:
            self._cache.clear()
            logger.info("Cache cleared")
    
    def cleanup_expired(self) -> int:
        """
        Remove all expired entries from the cache.
        
        Returns:
            Number of expired entries removed
        """
        with self._lock:
            expired_keys = []
            current_time = time.time()
            
            for key, entry in self._cache.items():
                if entry.expiry_time <= current_time:
                    expired_keys.append(key)
            
            for key in expired_keys:
                del self._cache[key]
            
            if expired_keys:
                logger.debug(f"Cleaned up {len(expired_keys)} expired entries")
            
            return len(expired_keys)
    
    def size(self) -> int:
        """Get the current number of entries in the cache."""
        with self._lock:
            return len(self._cache)
    
    def stats(self) -> dict:
        """
        Get cache statistics.
        
        Returns:
            Dictionary with cache statistics
        """
        with self._lock:
            total_entries = len(self._cache)
            expired_count = 0
            current_time = time.time()
            
            for entry in self._cache.values():
                if entry.expiry_time <= current_time:
                    expired_count += 1
            
            return {
                "size": total_entries,
                "max_size": self.max_size,
                "expired_entries": expired_count,
                "active_entries": total_entries - expired_count
            }


# Global cache instance
recommendation_cache = None


def init_cache(max_size: int = 1000, default_ttl: int = 300) -> InMemoryCache:
    """
    Initialize the global recommendation cache.
    
    Args:
        max_size: Maximum number of entries in the cache
        default_ttl: Default time to live in seconds
        
    Returns:
        The initialized cache instance
    """
    global recommendation_cache
    recommendation_cache = InMemoryCache(max_size=max_size, default_ttl=default_ttl)
    return recommendation_cache


def get_cache() -> Optional[InMemoryCache]:
    """Get the global recommendation cache instance."""
    return recommendation_cache