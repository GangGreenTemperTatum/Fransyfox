export interface MessageDebugSettings {
  consoleLogEnabled: boolean;
  debugBreakEnabled: boolean;
  debugBreakMatch: string;
  /** Max captured dataText length in characters; 0 disables the cap. */
  maxCapturedMessageSize: number;
}

export interface MatchReplaceRule {
  pattern: string;
  replacement: string;
}

export interface FransceiverSettings {
  dedupeEnabled: boolean;
  extensionActive: boolean;
  blockedListeners: string[];
  blockedUrls: string[];
  blockedRegex: string[];
  matchReplaceRules: MatchReplaceRule[];
  messageBeautifyEnabled: boolean;
  messageDebugSettings: MessageDebugSettings;
}
