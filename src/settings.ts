import {
  isRecencyField,
  isRecencyUnit,
  type RecencyField,
  type RecencyUnit,
} from './jira/jql';
import { normalizeMappingLabels } from './sync/label-filter';

export type ConflictPolicy = 'prefer-obsidian' | 'prefer-jira';
export type SyncIntervalUnit = 'minutes' | 'hours';
export type JiraAuthMode = 'cloud' | 'pat';
export type { RecencyField, RecencyUnit };
export { isRecencyField, isRecencyUnit };

export interface NoteBoardMapping {
  notePath: string;
  boardId: number;
  /**
   * Optional display name from the last Browse pick (e.g. `OPS / Team board`).
   * Not used by sync; cleared when the board id is typed manually.
   */
  boardName?: string;
  /**
   * Optional Jira label filter for this board.
   * Empty = sync all board issues. Non-empty = sync issues that have **any**
   * of these labels (OR). Status labels (to-do / in-progress / …) are separate.
   */
  labels: string[];
  /**
   * Optional recency window. `0` / unset = no limit (Jira search still caps ~1000).
   * Combined in JQL as `updated|created >= -Nd` / `-NM`.
   */
  recencyValue: number;
  recencyUnit: RecencyUnit;
  recencyField: RecencyField;
}

export interface PluginSettings {
  jiraBaseUrl: string;
  authMode: JiraAuthMode;
  jiraEmail: string;
  jiraApiToken: string;
  /** Custom field id for Start date, e.g. customfield_10015. Empty = skip start sync to Jira. */
  startDateFieldId: string;
  mappings: NoteBoardMapping[];
  conflictPolicy: ConflictPolicy;
  syncOnStartup: boolean;
  syncIntervalEnabled: boolean;
  syncIntervalValue: number;
  syncIntervalUnit: SyncIntervalUnit;
  syncOnFileChange: boolean;
  /** When true, Sync now previews actions without writing notes or Jira. */
  dryRunDefault: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  jiraBaseUrl: '',
  authMode: 'cloud',
  jiraEmail: '',
  jiraApiToken: '',
  startDateFieldId: '',
  mappings: [],
  conflictPolicy: 'prefer-obsidian',
  syncOnStartup: false,
  syncIntervalEnabled: false,
  syncIntervalValue: 15,
  syncIntervalUnit: 'minutes',
  syncOnFileChange: false,
  dryRunDefault: false,
};

/** Minimum allowed interval in minutes (architecture: at least 1 minute). */
export const MIN_SYNC_INTERVAL_MINUTES = 1;

export function normalizeSyncIntervalValue(value: number): number {
  if (!Number.isFinite(value) || value < MIN_SYNC_INTERVAL_MINUTES) {
    return MIN_SYNC_INTERVAL_MINUTES;
  }
  return Math.floor(value);
}

export function syncIntervalToMilliseconds(
  value: number,
  unit: SyncIntervalUnit,
): number {
  const normalized = normalizeSyncIntervalValue(value);
  const minutes = unit === 'hours' ? normalized * 60 : normalized;
  return minutes * 60 * 1000;
}

export function createEmptyMapping(): NoteBoardMapping {
  return {
    notePath: '',
    boardId: 0,
    labels: [],
    recencyValue: 0,
    recencyUnit: 'days',
    recencyField: 'updated',
  };
}

/** Normalize recency value: 0 disables the filter; negatives clamp to 0. */
export function normalizeRecencyValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/** Normalize a vault-relative note path from settings. Spaces in names are kept. */
export function normalizeMappingPath(path: string): string {
  // NFC avoids macOS NFD filename mismatches with Cyrillic typed in settings.
  return path.trim().replace(/^\/+/, '').normalize('NFC');
}

export function isMappingComplete(mapping: NoteBoardMapping): boolean {
  return normalizeMappingPath(mapping.notePath).length > 0 && mapping.boardId > 0;
}

/** True when the row is still the blank draft created by “Add mapping”. */
export function isMappingBlank(mapping: NoteBoardMapping): boolean {
  return normalizeMappingPath(mapping.notePath).length === 0 && !(mapping.boardId > 0);
}

/**
 * Normalize mapping fields in place.
 * Important: do not replace mapping objects or the mappings array — the settings
 * tab keeps closures/indexes into these objects across keystrokes.
 */
export function prepareMappingsForSave(mappings: NoteBoardMapping[]): void {
  for (const mapping of mappings) {
    mapping.notePath = normalizeMappingPath(mapping.notePath);
    if (!Number.isFinite(mapping.boardId) || mapping.boardId < 0) {
      mapping.boardId = 0;
    } else {
      mapping.boardId = Math.floor(mapping.boardId);
    }
    mapping.labels = normalizeMappingLabels(mapping.labels);
    mapping.recencyValue = normalizeRecencyValue(mapping.recencyValue);
    mapping.recencyUnit = isRecencyUnit(mapping.recencyUnit) ? mapping.recencyUnit : 'days';
    mapping.recencyField = isRecencyField(mapping.recencyField) ? mapping.recencyField : 'updated';
  }
}

/** Build the optional recency filter object for the Jira client (null when disabled). */
export function mappingRecencyFilter(mapping: {
  recencyValue?: number;
  recencyUnit?: RecencyUnit | string;
  recencyField?: RecencyField | string;
}): { field: RecencyField; value: number; unit: RecencyUnit } | null {
  const value = normalizeRecencyValue(mapping.recencyValue ?? 0);
  if (value <= 0) {
    return null;
  }
  return {
    field: isRecencyField(mapping.recencyField) ? mapping.recencyField : 'updated',
    value,
    unit: isRecencyUnit(mapping.recencyUnit) ? mapping.recencyUnit : 'days',
  };
}

export function isJiraAuthMode(value: unknown): value is JiraAuthMode {
  return value === 'cloud' || value === 'pat';
}
