export interface Finding {
  id: string;
  details?: string;
}

export interface ListenerRecord {
  window?: string;
  hops?: string;
  domain?: string;
  parent_url?: string;
  stack?: string;
  fullstack?: string[];
  listener: string;
  /** Compact identity of the original listener source. */
  listenerCaptureHash?: string;
  /** Original source length before capture truncation. */
  listenerLength?: number;
  /** Set when the listener source was truncated at capture. */
  listenerTruncated?: boolean;
  /** Capture timestamp used for oldest-first retention. */
  capturedAt?: number;
  jsurl?: string | null;
  blocked?: boolean;
  stale?: boolean;
  /** Real Chrome frameId of the frame the listener was registered in. */
  frameId?: number | null;
  /** Actual URL of that frame (sender.url), distinct from the top page URL. */
  frameUrl?: string;
  findings?: Finding[];
  findingsVersion?: number;
  listenerKey?: string;
  [key: string]: unknown;
}

export interface MessageEventRecord {
  id?: number;
  ts?: number;
  sourceFrame?: string;
  targetFrame?: string;
  origin?: string;
  dataText?: string;
  /** Set when dataText was truncated at capture (max-captured-size setting). */
  dataTruncated?: boolean;
  /** Original dataText length before capture truncation. */
  dataLength?: number;
  /** Real Chrome frameId of the receiving frame (from sender.frameId). */
  frameId?: number | null;
  [key: string]: unknown;
}

export type FrameSeverity = 'high' | 'medium' | 'low' | null;

/**
 * One node in a tab's frame graph. Identity is `frameId` (stable within a
 * navigation). Structure (parentFrameId/url) comes from chrome.webNavigation;
 * listenerCount/maxSeverity are derived from captured listeners.
 */
export interface FrameNode {
  frameId: number;
  parentFrameId: number;
  url: string;
  origin: string;
  /** Frame-hop label (e.g. "top.frames[0]") when known, for display/edge mapping. */
  hops?: string;
  listenerCount: number;
  maxSeverity: FrameSeverity;
}
