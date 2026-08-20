export const DEFAULT_CAPTURE_LIMIT_CHARS = 64 * 1024;
export const HARD_CAPTURE_LIMIT_CHARS = 256 * 1024;

export interface CapturedMessageData {
  dataType: string;
  dataText: string | undefined;
  dataTruncated?: boolean;
  dataLength?: number;
}

const LIMIT_EXCEEDED = new Error('capture-limit-exceeded');

export function getEffectiveCaptureLimit(configuredLimit: number): number {
  if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) {
    return DEFAULT_CAPTURE_LIMIT_CHARS;
  }
  return Math.min(Math.floor(configuredLimit), HARD_CAPTURE_LIMIT_CHARS);
}

function truncatedResult(dataType: string, limit: number, originalLength?: number): CapturedMessageData {
  const result: CapturedMessageData = {
    dataType,
    dataText: `[Payload omitted: exceeded ${limit}-character capture limit]`,
    dataTruncated: true
  };
  if (typeof originalLength === 'number') {
    result.dataLength = originalLength;
  }
  return result;
}

export function serializeForCapture(value: unknown, configuredLimit: number): CapturedMessageData {
  const dataType = typeof value;
  const limit = getEffectiveCaptureLimit(configuredLimit);

  if (typeof value === 'string') {
    if (value.length <= limit) return { dataType, dataText: value };
    return {
      dataType,
      dataText: value.slice(0, limit),
      dataTruncated: true,
      dataLength: value.length
    };
  }

  let estimatedChars = 0;
  try {
    const dataText = JSON.stringify(value, (key, entry: unknown) => {
      // Conservatively account for the property name, quotes/escapes, value,
      // and structural separators. Throwing stops JSON.stringify before it can
      // construct an arbitrarily large result string.
      estimatedChars += key.length * 2 + 4;
      if (typeof entry === 'string') estimatedChars += entry.length * 2 + 2;
      else if (typeof entry === 'number') estimatedChars += 24;
      else if (typeof entry === 'boolean' || entry === null) estimatedChars += 5;
      else estimatedChars += 2;
      if (estimatedChars > limit) throw LIMIT_EXCEEDED;
      return entry;
    });

    if (typeof dataText !== 'string') {
      return { dataType, dataText: undefined };
    }
    if (dataText.length > limit) {
      return {
        dataType,
        dataText: dataText.slice(0, limit),
        dataTruncated: true,
        dataLength: dataText.length
      };
    }
    return { dataType, dataText };
  } catch (error) {
    if (error === LIMIT_EXCEEDED) {
      return truncatedResult(dataType, limit);
    }
    return {
      dataType,
      dataText: `[Unserializable ${dataType} payload]`
    };
  }
}
