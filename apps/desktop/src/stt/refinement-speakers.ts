import type { TranscriptRecord } from "./queries";
import type { SpeakerHintWithId, WordWithId } from "./types";

const MIN_REFINED_SPEAKER_OVERLAP_RATIO = 0.6;

export function preserveConfirmedSpeakerAssignments(
  source: TranscriptRecord,
  words: WordWithId[],
  hints: SpeakerHintWithId[],
): SpeakerHintWithId[] {
  const { hints: reconciled, confirmedSourceKeys } = reconcileClusters(
    source,
    words,
    hints,
  );
  const sourceKeys = speakerKeysByWordId(source.speakerHints);
  const targetKeys = speakerKeysByWordId(reconciled);
  const assignments: SpeakerHintWithId[] = [];
  for (const hint of source.speakerHints) {
    const value = parseHintValue(hint.value);
    if (
      hint.type !== "user_speaker_assignment" &&
      !(
        hint.type === "automatic_speaker_assignment" &&
        value?.source === "voiceprint"
      )
    )
      continue;
    const provenance =
      hint.type === "automatic_speaker_assignment"
        ? { source: "voiceprint" }
        : {};
    const anchor = source.words.find((word) => word.id === hint.word_id);
    if (!value || typeof value.human_id !== "string" || !anchor) {
      throw new Error(
        "Cannot reconcile a confirmed speaker assignment. The live transcript was kept.",
      );
    }
    const channel =
      typeof value.channel === "number" ? value.channel : anchor.channel;
    const sourceKey =
      value.scope === "speaker" && typeof value.speaker_index === "number"
        ? `${channel}:${value.speaker_index}`
        : sourceKeys.get(anchor.id);
    if (
      value.scope !== "segment" &&
      (!sourceKey || confirmedSourceKeys.has(sourceKey))
    ) {
      const target = words.find(
        (word) =>
          word.channel === channel &&
          (sourceKey ? targetKeys.get(word.id) === sourceKey : true),
      );
      if (target) {
        assignments.push({
          id: `${target.id}:${hint.type}`,
          word_id: target.id,
          type: hint.type,
          value: JSON.stringify({
            ...provenance,
            human_id: value.human_id,
            scope: "speaker",
            channel,
            speaker_index: sourceKey
              ? parseSpeakerKey(sourceKey)!.speakerIndex
              : null,
          }),
        });
        continue;
      }
    }
    const sourceWordIds =
      value.scope === "segment" && Array.isArray(value.word_ids)
        ? new Set(value.word_ids)
        : null;
    const assignedWords = source.words.filter((word) =>
      sourceWordIds
        ? sourceWordIds.has(word.id)
        : sourceKey
          ? sourceKeys.get(word.id) === sourceKey
          : word.channel === channel,
    );
    const mappedWords = words.filter(
      (word) =>
        word.channel === channel &&
        assignedWords.some(
          (previous) =>
            Math.min(word.end_ms ?? 0, previous.end_ms ?? 0) >
            Math.max(word.start_ms ?? 0, previous.start_ms ?? 0),
        ),
    );
    if (mappedWords.length === 0) {
      throw new Error(
        "Cannot reconcile a confirmed speaker assignment. The live transcript was kept.",
      );
    }
    assignments.push({
      id: `${mappedWords[0].id}:${hint.type}:segment`,
      word_id: mappedWords[0].id,
      type: hint.type,
      value: JSON.stringify({
        ...provenance,
        human_id: value.human_id,
        scope: "segment",
        word_ids: mappedWords.map((word) => word.id),
      }),
    });
  }
  return [...reconciled, ...assignments];
}

function parseHintValue(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function speakerKeysByWordId(hints: SpeakerHintWithId[]) {
  const keys = new Map<string, string>();

  for (const hint of hints) {
    if (hint.type !== "provider_speaker_index" || !hint.word_id) {
      continue;
    }

    const value = parseHintValue(hint.value);
    const channel = value?.channel;
    const speakerIndex = value?.speaker_index;
    if (typeof channel !== "number" || typeof speakerIndex !== "number") {
      continue;
    }

    keys.set(hint.word_id, `${channel}:${speakerIndex}`);
  }

  return keys;
}

function parseSpeakerKey(key: string) {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) {
    return null;
  }

  const channel = Number(key.slice(0, separator));
  const speakerIndex = Number(key.slice(separator + 1));

  return Number.isFinite(channel) && Number.isFinite(speakerIndex)
    ? { channel, speakerIndex }
    : null;
}

export function reconcileRefinedSpeakerClusters(
  source: TranscriptRecord,
  words: WordWithId[],
  hints: SpeakerHintWithId[],
): SpeakerHintWithId[] {
  return reconcileClusters(source, words, hints).hints;
}

function reconcileClusters(
  source: TranscriptRecord,
  words: WordWithId[],
  hints: SpeakerHintWithId[],
) {
  const sourceSpeakerKeys = speakerKeysByWordId(source.speakerHints);
  const targetSpeakerKeys = speakerKeysByWordId(hints);
  if (sourceSpeakerKeys.size === 0 || targetSpeakerKeys.size === 0) {
    return { hints, confirmedSourceKeys: new Set<string>() };
  }

  const sourceIntervalsByChannel = new Map<
    number,
    Array<{
      speakerKey: string;
      startMs: number;
      endMs: number;
    }>
  >();

  for (const word of source.words) {
    const speakerKey = sourceSpeakerKeys.get(word.id);
    const speaker = speakerKey ? parseSpeakerKey(speakerKey) : null;
    if (!speakerKey || !speaker) {
      continue;
    }

    const startMs = word.start_ms ?? 0;
    const endMs = Math.max(startMs + 1, word.end_ms ?? startMs);
    const intervals = sourceIntervalsByChannel.get(speaker.channel) ?? [];
    intervals.push({ speakerKey, startMs, endMs });
    sourceIntervalsByChannel.set(speaker.channel, intervals);
  }

  for (const intervals of sourceIntervalsByChannel.values()) {
    intervals.sort((left, right) => left.startMs - right.startMs);
  }

  const targetWords = words
    .flatMap((word) => {
      const speakerKey = targetSpeakerKeys.get(word.id);
      const speaker = speakerKey ? parseSpeakerKey(speakerKey) : null;
      if (!speakerKey || !speaker) {
        return [];
      }

      const startMs = word.start_ms ?? 0;
      return [
        {
          speakerKey,
          channel: speaker.channel,
          startMs,
          endMs: Math.max(startMs + 1, word.end_ms ?? startMs),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.channel - right.channel || left.startMs - right.startMs,
    );
  const cursors = new Map<number, number>();
  const weights = new Map<string, Map<string, number>>();

  for (const word of targetWords) {
    const sourceIntervals = sourceIntervalsByChannel.get(word.channel);
    if (!sourceIntervals) {
      continue;
    }

    let cursor = cursors.get(word.channel) ?? 0;
    while (
      cursor < sourceIntervals.length &&
      sourceIntervals[cursor].endMs <= word.startMs
    ) {
      cursor += 1;
    }
    cursors.set(word.channel, cursor);

    for (
      let index = cursor;
      index < sourceIntervals.length &&
      sourceIntervals[index].startMs < word.endMs;
      index += 1
    ) {
      const source = sourceIntervals[index];
      const overlapMs =
        Math.min(word.endMs, source.endMs) -
        Math.max(word.startMs, source.startMs);
      if (overlapMs <= 0) {
        continue;
      }

      const sourceWeights = weights.get(word.speakerKey) ?? new Map();
      sourceWeights.set(
        source.speakerKey,
        (sourceWeights.get(source.speakerKey) ?? 0) + overlapMs,
      );
      weights.set(word.speakerKey, sourceWeights);
    }
  }

  const sourceSpeakerByTarget = new Map<string, number>();
  const unambiguousTargets = new Set<string>();
  for (const [targetSpeakerKey, sourceWeights] of weights) {
    const candidates = [...sourceWeights].sort(
      ([leftKey, leftWeight], [rightKey, rightWeight]) =>
        rightWeight - leftWeight || leftKey.localeCompare(rightKey),
    );
    const totalOverlapMs = candidates.reduce(
      (total, [, overlapMs]) => total + overlapMs,
      0,
    );
    const [sourceSpeakerKey, overlapMs] = candidates[0] ?? [];
    const sourceSpeaker = sourceSpeakerKey
      ? parseSpeakerKey(sourceSpeakerKey)
      : null;
    if (
      sourceSpeaker &&
      totalOverlapMs > 0 &&
      overlapMs / totalOverlapMs >= MIN_REFINED_SPEAKER_OVERLAP_RATIO
    ) {
      sourceSpeakerByTarget.set(targetSpeakerKey, sourceSpeaker.speakerIndex);
      if (candidates.length === 1) unambiguousTargets.add(targetSpeakerKey);
    }
  }

  const usedSpeakerIndicesByChannel = new Map<number, Set<number>>();
  for (const [targetSpeakerKey, speakerIndex] of sourceSpeakerByTarget) {
    const targetSpeaker = parseSpeakerKey(targetSpeakerKey);
    if (!targetSpeaker) {
      continue;
    }

    const usedSpeakerIndices =
      usedSpeakerIndicesByChannel.get(targetSpeaker.channel) ?? new Set();
    usedSpeakerIndices.add(speakerIndex);
    usedSpeakerIndicesByChannel.set(targetSpeaker.channel, usedSpeakerIndices);
  }

  const collidingTargetSpeakers: Array<{
    speakerKey: string;
    channel: number;
  }> = [];
  for (const targetSpeakerKey of new Set(targetSpeakerKeys.values())) {
    if (sourceSpeakerByTarget.has(targetSpeakerKey)) {
      continue;
    }

    const targetSpeaker = parseSpeakerKey(targetSpeakerKey);
    if (!targetSpeaker) {
      continue;
    }

    const usedSpeakerIndices =
      usedSpeakerIndicesByChannel.get(targetSpeaker.channel) ?? new Set();
    if (usedSpeakerIndices.has(targetSpeaker.speakerIndex)) {
      collidingTargetSpeakers.push({
        speakerKey: targetSpeakerKey,
        channel: targetSpeaker.channel,
      });
    } else {
      usedSpeakerIndices.add(targetSpeaker.speakerIndex);
    }
    usedSpeakerIndicesByChannel.set(targetSpeaker.channel, usedSpeakerIndices);
  }

  for (const { speakerKey, channel } of collidingTargetSpeakers) {
    const usedSpeakerIndices = usedSpeakerIndicesByChannel.get(channel);
    if (!usedSpeakerIndices) {
      continue;
    }

    let speakerIndex = Math.max(...usedSpeakerIndices) + 1;
    while (usedSpeakerIndices.has(speakerIndex)) {
      speakerIndex += 1;
    }
    usedSpeakerIndices.add(speakerIndex);
    sourceSpeakerByTarget.set(speakerKey, speakerIndex);
  }

  const confirmedSourceKeys = new Set<string>();
  const ambiguousSourceKeys = new Set<string>();
  for (const targetKey of new Set(targetSpeakerKeys.values())) {
    const target = parseSpeakerKey(targetKey)!;
    const key = `${target.channel}:${sourceSpeakerByTarget.get(targetKey) ?? target.speakerIndex}`;
    (unambiguousTargets.has(targetKey)
      ? confirmedSourceKeys
      : ambiguousSourceKeys
    ).add(key);
  }
  for (const key of ambiguousSourceKeys) confirmedSourceKeys.delete(key);

  const reconciled = hints.map((hint) => {
    if (hint.type !== "provider_speaker_index" || !hint.word_id) {
      return hint;
    }

    const targetSpeakerKey = targetSpeakerKeys.get(hint.word_id);
    const speakerIndex = targetSpeakerKey
      ? sourceSpeakerByTarget.get(targetSpeakerKey)
      : undefined;
    const value = parseHintValue(hint.value);
    if (speakerIndex === undefined || !value) {
      return hint;
    }

    return {
      ...hint,
      value: JSON.stringify({ ...value, speaker_index: speakerIndex }),
    };
  });
  return { hints: reconciled, confirmedSourceKeys };
}
