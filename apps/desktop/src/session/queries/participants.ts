import type {
  SessionParticipantRecord,
  SessionSpeakerCandidate,
} from "./types";

import { executeTransaction, liveQueryClient, useLiveQuery } from "~/db";
import { enqueueDatabaseWrite } from "~/db/write-queue";
import { id } from "~/shared/utils";

type SessionParticipantSqlRow = {
  id: string;
  session_id: string;
  human_id: string;
  source: string;
  name: string;
  email: string;
  job_title: string;
  linkedin_username: string;
  organization_id: string;
  organization_name: string;
};

const EMPTY_SESSION_PARTICIPANTS: SessionParticipantRecord[] = [];
const EMPTY_SPEAKER_CANDIDATES: SessionSpeakerCandidate[] = [];
const SPEAKER_CANDIDATES_SQL = `
  SELECT
    participant.id,
    participant.human_id,
    participant.source,
    COALESCE(NULLIF(human.name, ''), participant.display_name) AS name
  FROM session_participants AS participant
  LEFT JOIN humans AS human
    ON human.id = participant.human_id AND human.deleted_at IS NULL
  WHERE participant.session_id = ?
    AND participant.deleted_at IS NULL
    AND participant.source IN ('observed', 'auto', 'manual')
`;

type SpeakerCandidateSqlRow = Pick<
  ObservedParticipantMatchRow,
  "human_id" | "id" | "name" | "source"
>;

export function useSessionParticipants(
  sessionId: string,
): SessionParticipantRecord[] {
  const { data = EMPTY_SESSION_PARTICIPANTS } = useLiveQuery<
    SessionParticipantSqlRow,
    SessionParticipantRecord[]
  >({
    sql: `
      SELECT
        participant.id,
        participant.session_id,
        participant.human_id,
        participant.source,
        COALESCE(NULLIF(human.name, ''), participant.display_name) AS name,
        COALESCE(NULLIF(human.email, ''), participant.email) AS email,
        COALESCE(human.job_title, '') AS job_title,
        COALESCE(human.linkedin_username, '') AS linkedin_username,
        COALESCE(human.organization_id, '') AS organization_id,
        COALESCE(organization.name, '') AS organization_name
      FROM session_participants AS participant
      LEFT JOIN humans AS human
        ON human.id = participant.human_id AND human.deleted_at IS NULL
      LEFT JOIN organizations AS organization
        ON organization.id = human.organization_id
        AND organization.deleted_at IS NULL
      WHERE participant.session_id = ?
        AND participant.deleted_at IS NULL
      ORDER BY name, email, participant.id
    `,
    params: [sessionId],
    enabled: Boolean(sessionId),
    mapRows: (rows) => rows.map(mapSessionParticipantRow),
  });
  return sessionId ? data : EMPTY_SESSION_PARTICIPANTS;
}

export function useSessionParticipant(
  mappingId: string,
): SessionParticipantRecord | null {
  const { data = null } = useLiveQuery<
    SessionParticipantSqlRow,
    SessionParticipantRecord | null
  >({
    sql: `
      SELECT
        participant.id,
        participant.session_id,
        participant.human_id,
        participant.source,
        COALESCE(NULLIF(human.name, ''), participant.display_name) AS name,
        COALESCE(NULLIF(human.email, ''), participant.email) AS email,
        COALESCE(human.job_title, '') AS job_title,
        COALESCE(human.linkedin_username, '') AS linkedin_username,
        COALESCE(human.organization_id, '') AS organization_id,
        COALESCE(organization.name, '') AS organization_name
      FROM session_participants AS participant
      LEFT JOIN humans AS human
        ON human.id = participant.human_id AND human.deleted_at IS NULL
      LEFT JOIN organizations AS organization
        ON organization.id = human.organization_id
        AND organization.deleted_at IS NULL
      WHERE participant.id = ? AND participant.deleted_at IS NULL
      LIMIT 1
    `,
    params: [mappingId],
    enabled: Boolean(mappingId),
    mapRows: (rows) => (rows[0] ? mapSessionParticipantRow(rows[0]) : null),
  });
  return mappingId ? data : null;
}

export function useSessionSpeakerCandidates(
  sessionId: string,
): SessionSpeakerCandidate[] {
  const { data = EMPTY_SPEAKER_CANDIDATES } = useLiveQuery<
    SpeakerCandidateSqlRow,
    SessionSpeakerCandidate[]
  >({
    sql: SPEAKER_CANDIDATES_SQL,
    params: [sessionId],
    enabled: Boolean(sessionId),
    mapRows: mapSpeakerCandidates,
  });
  return sessionId ? data : EMPTY_SPEAKER_CANDIDATES;
}

export function addSessionParticipant(
  sessionId: string,
  humanId: string,
  source = "manual",
): Promise<void> {
  return enqueueDatabaseWrite("session-participants", async () => {
    const participantId = id();
    const now = new Date().toISOString();
    await executeTransaction([
      {
        sql: `
          UPDATE session_participants
          SET source = ?, updated_at = ?
          WHERE id = (
            SELECT id
            FROM session_participants
            WHERE session_id = ?
              AND human_id = ?
              AND source = 'excluded'
              AND deleted_at IS NULL
              AND ? <> 'auto'
            ORDER BY created_at, id
            LIMIT 1
          )
        `,
        params: [source, now, sessionId, humanId, source],
      },
      {
        sql: `
          INSERT INTO session_participants (
            id, workspace_id, owner_user_id, session_id, human_id,
            display_name, email, role, source, metadata_json, created_at,
            updated_at, deleted_at
          )
          SELECT ?, session.workspace_id, session.owner_user_id, session.id, human.id,
            human.name, human.email, '', ?, '{}', ?, ?, NULL
          FROM sessions AS session
          JOIN humans AS human ON human.id = ? AND human.deleted_at IS NULL
          WHERE session.id = ?
            AND session.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM session_participants AS existing
              WHERE existing.session_id = session.id
                AND existing.human_id = human.id
                AND existing.deleted_at IS NULL
            )
        `,
        params: [participantId, source, now, now, humanId, sessionId],
      },
    ]);
  });
}

export function removeSessionParticipant(mappingId: string): Promise<void> {
  return enqueueDatabaseWrite("session-participants", async () => {
    const now = new Date().toISOString();
    await executeTransaction([
      {
        sql: `
          UPDATE session_participants
          SET
            source = CASE WHEN source = 'auto' THEN 'excluded' ELSE source END,
            deleted_at = CASE WHEN source = 'auto' THEN NULL ELSE ? END,
            updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `,
        params: [now, now, mappingId],
      },
    ]);
  });
}

type ObservedParticipantMatchRow = {
  id: string;
  human_id: string;
  source: string;
  name: string;
};

export function persistObservedParticipants(
  sessionId: string,
  displayNames: readonly string[],
): Promise<void> {
  return enqueueDatabaseWrite("session-participants", async () => {
    const normalizedNames = new Map<string, string>();
    for (const displayName of displayNames) {
      const normalized = normalizeParticipantDisplayName(displayName);
      if (isSpeakerCandidateName(normalized)) {
        normalizedNames.set(normalized.toLocaleLowerCase(), normalized);
      }
    }
    if (!sessionId || normalizedNames.size === 0) {
      return;
    }

    const existing = await liveQueryClient.execute<ObservedParticipantMatchRow>(
      `
        SELECT
          participant.id,
          participant.human_id,
          participant.source,
          COALESCE(NULLIF(human.name, ''), participant.display_name) AS name
        FROM session_participants AS participant
        LEFT JOIN humans AS human
          ON human.id = participant.human_id AND human.deleted_at IS NULL
        WHERE participant.session_id = ?
          AND participant.deleted_at IS NULL
          AND participant.source <> 'excluded'
      `,
      [sessionId],
    );
    const now = new Date().toISOString();
    const statements: Array<{ sql: string; params: unknown[] }> = [];

    for (const [nameKey, displayName] of normalizedNames) {
      const matchingNames = existing.filter(
        (participant) =>
          normalizeParticipantDisplayName(
            participant.name,
          )?.toLocaleLowerCase() === nameKey,
      );
      const humanIds = new Set(
        matchingNames
          .map((participant) => participant.human_id)
          .filter(Boolean),
      );
      const [unambiguousHumanId] = humanIds.size === 1 ? [...humanIds] : [];
      const match = unambiguousHumanId
        ? matchingNames.find(
            (participant) => participant.human_id === unambiguousHumanId,
          )
        : matchingNames.find((participant) => !participant.human_id);

      if (match) {
        statements.push({
          sql: `
            UPDATE session_participants
            SET
              display_name = ?,
              source = 'observed',
              first_observed_at = COALESCE(first_observed_at, ?),
              last_observed_at = ?,
              updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
          `,
          params: [displayName, now, now, now, match.id],
        });
        continue;
      }

      statements.push({
        sql: `
          INSERT INTO session_participants (
            id, workspace_id, owner_user_id, session_id, human_id,
            display_name, email, role, source, metadata_json,
            first_observed_at, last_observed_at, created_at, updated_at,
            deleted_at
          )
          SELECT
            ?, session.workspace_id, session.owner_user_id, session.id, '',
            ?, '', '', 'observed', '{}', ?, ?, ?, ?, NULL
          FROM sessions AS session
          WHERE session.id = ? AND session.deleted_at IS NULL
        `,
        params: [id(), displayName, now, now, now, now, sessionId],
      });
    }

    await executeTransaction(statements);
  });
}

export function normalizeParticipantDisplayName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mapSpeakerCandidates(
  rows: SpeakerCandidateSqlRow[],
): SessionSpeakerCandidate[] {
  const sourcePriority = { observed: 0, calendar: 1, manual: 2 } as const;
  const knownByHumanId = new Map<
    string,
    SessionSpeakerCandidate & { nameKey: string }
  >();
  const anonymousByName = new Map<
    string,
    SessionSpeakerCandidate & { nameKey: string }
  >();

  for (const row of rows) {
    const name = normalizeParticipantDisplayName(row.name);
    const nameKey = name.toLocaleLowerCase();
    if (!isSpeakerCandidateName(name)) {
      continue;
    }
    const candidate = {
      humanId: row.human_id,
      name,
      nameKey,
      source:
        row.source === "observed"
          ? "observed"
          : row.source === "auto"
            ? "calendar"
            : "manual",
    } satisfies SessionSpeakerCandidate & { nameKey: string };
    const candidates = row.human_id ? knownByHumanId : anonymousByName;
    const key = row.human_id || nameKey;
    const existing = candidates.get(key);
    if (
      !existing ||
      sourcePriority[candidate.source] < sourcePriority[existing.source]
    ) {
      candidates.set(key, candidate);
    }
  }

  const knownByName = new Map<
    string,
    Array<SessionSpeakerCandidate & { nameKey: string }>
  >();
  for (const candidate of knownByHumanId.values()) {
    const matches = knownByName.get(candidate.nameKey) ?? [];
    matches.push(candidate);
    knownByName.set(candidate.nameKey, matches);
  }

  for (const [nameKey, anonymous] of anonymousByName) {
    const knownMatches = knownByName.get(nameKey) ?? [];
    if (knownMatches.length !== 1) {
      continue;
    }
    const [known] = knownMatches;
    if (sourcePriority[anonymous.source] < sourcePriority[known.source]) {
      known.source = anonymous.source;
    }
    anonymousByName.delete(nameKey);
  }

  return [...knownByHumanId.values(), ...anonymousByName.values()]
    .sort(
      (left, right) =>
        sourcePriority[left.source] - sourcePriority[right.source] ||
        left.name.localeCompare(right.name) ||
        left.humanId.localeCompare(right.humanId),
    )
    .map(({ humanId, name, source }) => ({ humanId, name, source }));
}

function isSpeakerCandidateName(value: string): boolean {
  return Boolean(value && value.length <= 160 && !value.includes("@"));
}

function mapSessionParticipantRow(
  row: SessionParticipantSqlRow,
): SessionParticipantRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    humanId: row.human_id,
    source: row.source,
    name: row.name,
    email: row.email,
    jobTitle: row.job_title,
    linkedinUsername: row.linkedin_username,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
  };
}
