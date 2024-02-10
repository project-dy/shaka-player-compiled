/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.media.SegmentPrefetch');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.media.InitSegmentReference');
goog.require('shaka.media.SegmentReference');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.util.Uint8ArrayUtils');


/**
 * @summary
 * This class manages segment prefetch operations.
 * Called by StreamingEngine to prefetch next N segments
 * ahead of playhead, to reduce the chances of rebuffering.
 */
shaka.media.SegmentPrefetch = class {
  /**
   * @param {number} prefetchLimit
   * @param {shaka.extern.Stream} stream
   * @param {shaka.media.SegmentPrefetch.FetchDispatcher} fetchDispatcher
   * @param {boolean} deleteOnGet
   */
  constructor(prefetchLimit, stream, fetchDispatcher, deleteOnGet = true) {
    /** @private {number} */
    this.prefetchLimit_ = prefetchLimit;

    /** @private {shaka.extern.Stream} */
    this.stream_ = stream;

    /** @private {number} */
    this.prefetchPosTime_ = 0;

    /** @private {shaka.media.SegmentPrefetch.FetchDispatcher} */
    this.fetchDispatcher_ = fetchDispatcher;

    /** @private {boolean} */
    this.deleteOnGet_ = deleteOnGet;

    /**
     * @private {!Map.<
     *        !(shaka.media.SegmentReference),
     *        !shaka.media.SegmentPrefetchOperation>}
     */
    this.segmentPrefetchMap_ = new Map();

    /**
     * @private {!Map.<
     *        !(shaka.media.InitSegmentReference),
     *        !shaka.media.SegmentPrefetchOperation>}
     */
    this.initSegmentPrefetchMap_ = new Map();
  }

  /**
   * @param {shaka.media.SegmentPrefetch.FetchDispatcher} fetchDispatcher
   */
  replaceFetchDispatcher(fetchDispatcher) {
    this.fetchDispatcher_ = fetchDispatcher;
    for (const operation of this.segmentPrefetchMap_.values()) {
      operation.replaceFetchDispatcher(fetchDispatcher);
    }
  }

  /**
   * @return {number}
   */
  getLastKnownPosition() {
    return this.prefetchPosTime_;
  }

  /**
   * Fetch next segments ahead of current time.
   *
   * @param {number} currTime
   * @param {boolean=} skipFirst
   * @public
   */
  prefetchSegmentsByTime(currTime, skipFirst = false) {
    goog.asserts.assert(this.prefetchLimit_ > 0,
        'SegmentPrefetch can not be used when prefetchLimit <= 0.');

    const logPrefix = shaka.media.SegmentPrefetch.logPrefix_(this.stream_);
    if (!this.stream_.segmentIndex) {
      shaka.log.debug(logPrefix, 'missing segmentIndex');
      return;
    }
    const maxTime = Math.max(currTime, this.prefetchPosTime_);
    const iterator = this.stream_.segmentIndex.getIteratorForTime(
        maxTime, /* allowNonIndepedent= */ true);
    if (!iterator) {
      return;
    }
    let reference = iterator.next().value;
    if (skipFirst) {
      reference = iterator.next().value;
    }
    if (!reference) {
      return;
    }
    while (this.segmentPrefetchMap_.size < this.prefetchLimit_ &&
            reference != null) {
      // By default doesn't prefech preload partial segments when using
      // byterange
      let prefetchAllowed = true;
      if (reference.isPreload() && reference.endByte != null) {
        prefetchAllowed = false;
      }
      if (reference.getStatus() ==
          shaka.media.SegmentReference.Status.MISSING) {
        prefetchAllowed = false;
      }
      if (prefetchAllowed && reference.initSegmentReference) {
        this.prefetchInitSegment(reference.initSegmentReference);
      }
      if (prefetchAllowed && !this.segmentPrefetchMap_.has(reference)) {
        const segmentPrefetchOperation =
          new shaka.media.SegmentPrefetchOperation(this.fetchDispatcher_);
        segmentPrefetchOperation.dispatchFetch(reference, this.stream_);
        this.segmentPrefetchMap_.set(reference, segmentPrefetchOperation);
      }
      this.prefetchPosTime_ = reference.startTime;
      if (this.stream_.fastSwitching && reference.isPartial() &&
          reference.isLastPartial()) {
        break;
      }
      reference = iterator.next().value;
    }
    this.clearInitSegments_();
  }

  /**
   * Fetch init segment.
   *
   * @param {!shaka.media.InitSegmentReference} initSegmentReference
   */
  prefetchInitSegment(initSegmentReference) {
    goog.asserts.assert(this.prefetchLimit_ > 0,
        'SegmentPrefetch can not be used when prefetchLimit <= 0.');

    const logPrefix = shaka.media.SegmentPrefetch.logPrefix_(this.stream_);
    if (!this.stream_.segmentIndex) {
      shaka.log.debug(logPrefix, 'missing segmentIndex');
      return;
    }

    // init segments are ignored from the prefetch limit
    if (!this.initSegmentPrefetchMap_.has(initSegmentReference)) {
      const segmentPrefetchOperation =
        new shaka.media.SegmentPrefetchOperation(this.fetchDispatcher_);
      segmentPrefetchOperation.dispatchFetch(
          initSegmentReference, this.stream_);
      this.initSegmentPrefetchMap_.set(
          initSegmentReference, segmentPrefetchOperation);
    }
  }

  /**
   * Get the result of prefetched segment if already exists.
   * @param {!(shaka.media.SegmentReference|shaka.media.InitSegmentReference)}
   *        reference
   * @param {?function(BufferSource):!Promise=} streamDataCallback
   * @return {?shaka.net.NetworkingEngine.PendingRequest} op
   * @public
   */
  getPrefetchedSegment(reference, streamDataCallback) {
    goog.asserts.assert(this.prefetchLimit_ > 0,
        'SegmentPrefetch can not be used when prefetchLimit <= 0.');

    const logPrefix = shaka.media.SegmentPrefetch.logPrefix_(this.stream_);

    let prefetchMap = this.segmentPrefetchMap_;
    if (reference instanceof shaka.media.InitSegmentReference) {
      prefetchMap = this.initSegmentPrefetchMap_;
    }

    if (prefetchMap.has(reference)) {
      const segmentPrefetchOperation = prefetchMap.get(reference);
      if (streamDataCallback) {
        segmentPrefetchOperation.setStreamDataCallback(streamDataCallback);
      }
      if (this.deleteOnGet_) {
        prefetchMap.delete(reference);
      }
      if (reference instanceof shaka.media.SegmentReference) {
        shaka.log.debug(
            logPrefix,
            'reused prefetched segment at time:', reference.startTime,
            'mapSize', prefetchMap.size);
      } else {
        shaka.log.debug(
            logPrefix,
            'reused prefetched init segment at time, mapSize',
            prefetchMap.size);
      }
      return segmentPrefetchOperation.getOperation();
    } else {
      if (reference instanceof shaka.media.SegmentReference) {
        shaka.log.debug(
            logPrefix,
            'missed segment at time:', reference.startTime,
            'mapSize', prefetchMap.size);
      } else {
        shaka.log.debug(
            logPrefix,
            'missed init segment at time, mapSize',
            prefetchMap.size);
      }
      return null;
    }
  }

  /**
   * Clear All Helper
   * @private
   */
  clearMap_(map) {
    for (const reference of map.keys()) {
      if (reference) {
        this.abortPrefetchedSegment_(reference);
      }
    }
  }

  /**
   * Clear all segment data.
   * @public
   */
  clearAll() {
    this.clearMap_(this.segmentPrefetchMap_);
    this.clearMap_(this.initSegmentPrefetchMap_);
    const logPrefix = shaka.media.SegmentPrefetch.logPrefix_(this.stream_);
    shaka.log.debug(logPrefix, 'cleared all');
    this.prefetchPosTime_ = 0;
  }

  /**
   * @param {number} time
   */
  evict(time) {
    for (const ref of this.segmentPrefetchMap_.keys()) {
      if (time > ref.endTime) {
        this.abortPrefetchedSegment_(ref);
      }
    }
    this.clearInitSegments_();
  }

  /**
   * Remove all init segments that don't have associated segments in
   * the segment prefetch map.
   * By default, with delete on get, the init segments should get removed as
   * they are used. With deleteOnGet set to false, we need to clear them
   * every so often once the segments that are associated with each init segment
   * is no longer prefetched.
   * @private
   */
  clearInitSegments_() {
    const segmentReferences = Array.from(this.segmentPrefetchMap_.keys());
    for (const initSegmentReference of this.initSegmentPrefetchMap_.keys()) {
      // if no segment references this init segment, we should remove it.
      if (!segmentReferences.some(
          (segmentReference) =>
            segmentReference.initSegmentReference === initSegmentReference)) {
        this.abortPrefetchedSegment_(initSegmentReference);
      }
    }
  }

  /**
   * Reset the prefetchLimit and clear all internal states.
   * Called by StreamingEngine when configure() was called.
   * @param {number} newPrefetchLimit
   * @public
   */
  resetLimit(newPrefetchLimit) {
    goog.asserts.assert(newPrefetchLimit >= 0,
        'The new prefetch limit must be >= 0.');

    const logPrefix = shaka.media.SegmentPrefetch.logPrefix_(this.stream_);
    shaka.log.debug(logPrefix, 'resetting prefetch limit to', newPrefetchLimit);
    this.prefetchLimit_ = newPrefetchLimit;
    const keyArr = Array.from(this.segmentPrefetchMap_.keys());
    while (keyArr.length > newPrefetchLimit) {
      const reference = keyArr.pop();
      if (reference) {
        this.abortPrefetchedSegment_(reference);
      }
    }
    this.clearInitSegments_();
  }

  /**
   * Update deleteOnGet.
   * @param {boolean} newDeleteOnGet
   * @public
   */
  deleteOnGet(newDeleteOnGet) {
    this.deleteOnGet_ = newDeleteOnGet;
  }

  /**
   * Called by Streaming Engine when switching variant.
   * @param {shaka.extern.Stream} stream
   * @public
   */
  switchStream(stream) {
    goog.asserts.assert(this.deleteOnGet_,
        'switchStream should only be used if deleteOnGet is true');

    if (stream && stream !== this.stream_) {
      this.clearAll();
      this.stream_ = stream;
    }
  }

  /**
   * Get the current stream.
   * @public
   * @return {shaka.extern.Stream}
   */
  getStream() {
    return this.stream_;
  }

  /**
   * Remove a segment from prefetch map and abort it.
   * @param {!(shaka.media.SegmentReference|shaka.media.InitSegmentReference)}
   *        reference
   * @private
   */
  abortPrefetchedSegment_(reference) {
    const logPrefix = shaka.media.SegmentPrefetch.logPrefix_(this.stream_);

    let prefetchMap = this.segmentPrefetchMap_;
    if (reference instanceof shaka.media.InitSegmentReference) {
      prefetchMap = this.initSegmentPrefetchMap_;
    }

    const segmentPrefetchOperation = prefetchMap.get(reference);
    prefetchMap.delete(reference);

    if (segmentPrefetchOperation) {
      segmentPrefetchOperation.abort();
      if (reference instanceof shaka.media.SegmentReference) {
        shaka.log.debug(
            logPrefix,
            'pop and abort prefetched segment at time:', reference.startTime);
      } else {
        shaka.log.debug(logPrefix, 'pop and abort prefetched init segment');
      }
    }
  }

  /**
   * The prefix of the logs that are created in this class.
   * @return {string}
   * @private
   */
  static logPrefix_(stream) {
    return 'SegmentPrefetch(' + stream.type + ':' + stream.id + ')';
  }
};

/**
 * @summary
 * This class manages a segment prefetch operation.
 */
shaka.media.SegmentPrefetchOperation = class {
  /**
   * @param {shaka.media.SegmentPrefetch.FetchDispatcher} fetchDispatcher
   */
  constructor(fetchDispatcher) {
    /** @private {shaka.media.SegmentPrefetch.FetchDispatcher} */
    this.fetchDispatcher_ = fetchDispatcher;

    /** @private {?function(BufferSource):!Promise} */
    this.streamDataCallback_ = null;

    /** @private {?shaka.net.NetworkingEngine.PendingRequest} */
    this.operation_ = null;
  }

  /**
   * @param {shaka.media.SegmentPrefetch.FetchDispatcher} fetchDispatcher
   */
  replaceFetchDispatcher(fetchDispatcher) {
    this.fetchDispatcher_ = fetchDispatcher;
  }

  /**
   * Fetch a segments
   *
   * @param {!(shaka.media.SegmentReference|shaka.media.InitSegmentReference)}
   *        reference
   * @param {!shaka.extern.Stream} stream
   * @public
   */
  dispatchFetch(reference, stream) {
    // We need to store the data, because streamDataCallback_ might not be
    // available when you start getting the first data.
    let buffered = new Uint8Array(0);
    this.operation_ = this.fetchDispatcher_(
        reference, stream, async (data) => {
          if (buffered.byteLength > 0) {
            buffered = shaka.util.Uint8ArrayUtils.concat(buffered, data);
          } else {
            buffered = data;
          }
          if (this.streamDataCallback_) {
            await this.streamDataCallback_(buffered);
            buffered = new Uint8Array(0);
          }
        });
  }

  /**
   * Get the operation of prefetched segment if already exists.
   *
   * @return {?shaka.net.NetworkingEngine.PendingRequest} op
   * @public
   */
  getOperation() {
    return this.operation_;
  }

  /**
   * @param {?function(BufferSource):!Promise} streamDataCallback
   * @public
   */
  setStreamDataCallback(streamDataCallback) {
    this.streamDataCallback_ = streamDataCallback;
  }

  /**
   * Abort the current operation if exists.
   */
  abort() {
    if (this.operation_) {
      this.operation_.abort();
    }
  }
};

/**
 * @typedef {function(
 *  !(shaka.media.InitSegmentReference|shaka.media.SegmentReference),
 *  shaka.extern.Stream,
 *  ?function(BufferSource):!Promise=
 * ):!shaka.net.NetworkingEngine.PendingRequest}
 *
 * @description
 * A callback function that fetches a segment.
 * @export
 */
shaka.media.SegmentPrefetch.FetchDispatcher;
