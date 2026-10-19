import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type JiraSyncPlugin from './main';
import {
  createEmptyMapping,
  isMappingBlank,
  isMappingComplete,
  isRecencyField,
  isRecencyUnit,
  normalizeRecencyValue,
  normalizeSyncIntervalValue,
  type ConflictPolicy,
  type JiraAuthMode,
  type NoteBoardMapping,
  type SyncIntervalUnit,
} from './settings';
import type { AssigneeMapping } from './sync/assignee';
import {
  formatLabelList,
  normalizeMappingLabels,
  parseLabelListInput,
} from './sync/label-filter';
import { formatBoardSummary } from './jira/board-display';
import { openBoardPicker } from './vault/board-suggest-modal';
import { LabelSuggestModal } from './vault/label-suggest-modal';
import { NoteSuggestModal } from './vault/note-suggest-modal';
import { resolveMarkdownFile } from './vault/resolve-note';

export class JiraSyncSettingTab extends PluginSettingTab {
  plugin: JiraSyncPlugin;

  constructor(app: App, plugin: JiraSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Jira Sync' });
    containerEl.createEl('p', {
      text: 'Configure connection, note ↔ board mappings, conflict policy, and sync triggers. Commands: Sync now, Preview sync (dry run). Ribbon button also starts sync.',
    });

    this.renderConnectionSection(containerEl);
    this.renderDateFieldsSection(containerEl);
    this.renderAssigneeMappingsSection(containerEl);
    this.renderMappingsSection(containerEl);
    this.renderConflictSection(containerEl);
    this.renderTriggersSection(containerEl);
    this.renderMaintenanceSection(containerEl);
  }

  private renderConnectionSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Connection' });

    new Setting(containerEl)
      .setName('Jira base URL')
      .setDesc('Site root without a trailing /rest path. Example: https://your.atlassian.net')
      .addText((text) =>
        text
          .setPlaceholder('https://your.atlassian.net')
          .setValue(this.plugin.settings.jiraBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.jiraBaseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auth mode')
      .setDesc('Cloud uses email + API token (Basic). Self-hosted uses a Personal Access Token (Bearer).')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('cloud', 'Cloud (email + API token)')
          .addOption('pat', 'Self-hosted PAT')
          .setValue(this.plugin.settings.authMode)
          .onChange(async (value) => {
            this.plugin.settings.authMode = value as JiraAuthMode;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.authMode === 'cloud') {
      new Setting(containerEl)
        .setName('Email')
        .setDesc('Atlassian account email for Cloud Basic auth')
        .addText((text) =>
          text
            .setPlaceholder('you@example.com')
            .setValue(this.plugin.settings.jiraEmail)
            .onChange(async (value) => {
              this.plugin.settings.jiraEmail = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName('API token')
      .setDesc(
        this.plugin.settings.authMode === 'cloud'
          ? 'Atlassian API token'
          : 'Personal Access Token (Bearer)',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Token')
          .setValue(this.plugin.settings.jiraApiToken)
          .onChange(async (value) => {
            this.plugin.settings.jiraApiToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Calls /rest/api/2/myself and lists Agile boards')
      .addButton((button) =>
        button.setButtonText('Test connection').onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await this.plugin.testJiraConnection();
            if (result.ok) {
              new Notice(
                `Jira Sync: connection OK (${result.displayName}, ${result.boardCount} board${result.boardCount === 1 ? '' : 's'}).`,
              );
            } else {
              new Notice(`Jira Sync: connection failed — ${result.message}`);
            }
          } finally {
            button.setDisabled(false);
          }
        }),
      );
  }

  private renderDateFieldsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Date fields' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Due (📅): Actual end wins when set, otherwise Target end. Obsidian due date writes back to Target end only. Start (🛫): Start field, or Actual end − time tracking when Start is empty.',
    });

    new Setting(containerEl)
      .setName('Start date field id')
      .setDesc('Custom field id for 🛫 markers, e.g. customfield_10015. Leave empty to skip start sync to Jira.')
      .addText((text) =>
        text
          .setPlaceholder('customfield_10015')
          .setValue(this.plugin.settings.startDateFieldId)
          .onChange(async (value) => {
            this.plugin.settings.startDateFieldId = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Find').onClick(async () => {
          await this.findAndStoreField('Start date', (id) => {
            this.plugin.settings.startDateFieldId = id;
          });
        }),
      );

    new Setting(containerEl)
      .setName('Actual end field id')
      .setDesc(
        'When filled, this wins for Obsidian 📅. Also used with time tracking to derive 🛫 when Start is empty. Leave empty to ignore.',
      )
      .addText((text) =>
        text
          .setPlaceholder('customfield_…')
          .setValue(this.plugin.settings.actualEndFieldId)
          .onChange(async (value) => {
            this.plugin.settings.actualEndFieldId = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Find').onClick(async () => {
          await this.findAndStoreField('Actual end', (id) => {
            this.plugin.settings.actualEndFieldId = id;
          });
        }),
      );

    new Setting(containerEl)
      .setName('Target end field id')
      .setDesc(
        'Used when Actual end is empty, and when Obsidian updates 📅. Default is the standard Due date field (`duedate`).',
      )
      .addText((text) =>
        text
          .setPlaceholder('duedate')
          .setValue(this.plugin.settings.targetEndFieldId || 'duedate')
          .onChange(async (value) => {
            const trimmed = value.trim();
            this.plugin.settings.targetEndFieldId = trimmed || 'duedate';
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Find').onClick(async () => {
          await this.findAndStoreField('Target end', (id) => {
            this.plugin.settings.targetEndFieldId = id;
          });
        }),
      );

    containerEl.createEl('h3', { text: 'Time spent' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Syncs Jira Time Tracking into Dataview [timespent:: <seconds>] on open tasks (Jira → Obsidian only). Changes to [timespent:: …] in Obsidian are not written back to Jira because of Jira worklog limitations — edit time in Jira.',
    });

    new Setting(containerEl)
      .setName('Time spent field id')
      .setDesc(
        'Source field for pull-only sync. Default `timetracking` (uses timeSpentSeconds). Use `timespent` or a custom field id if needed.',
      )
      .addText((text) =>
        text
          .setPlaceholder('timetracking')
          .setValue(this.plugin.settings.timeSpentFieldId || 'timetracking')
          .onChange(async (value) => {
            const trimmed = value.trim();
            this.plugin.settings.timeSpentFieldId = trimmed || 'timetracking';
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Find').onClick(async () => {
          const tracking = await this.plugin.findJiraFieldByName('Time Tracking');
          if (tracking.ok) {
            this.plugin.settings.timeSpentFieldId = tracking.fieldId;
            await this.plugin.saveSettings();
            new Notice(`Jira Sync: using ${tracking.name} (${tracking.fieldId}).`);
            this.display();
            return;
          }
          const spent = await this.plugin.findJiraFieldByName('Time Spent');
          if (spent.ok) {
            this.plugin.settings.timeSpentFieldId = spent.fieldId;
            await this.plugin.saveSettings();
            new Notice(`Jira Sync: using ${spent.name} (${spent.fieldId}).`);
            this.display();
            return;
          }
          new Notice(
            `Jira Sync: ${tracking.message} Also tried “Time Spent”: ${spent.message}`,
          );
        }),
      );
  }

  private async findAndStoreField(
    fieldName: string,
    assign: (fieldId: string) => void,
  ): Promise<void> {
    const result = await this.plugin.findJiraFieldByName(fieldName);
    if (result.ok) {
      assign(result.fieldId);
      await this.plugin.saveSettings();
      new Notice(`Jira Sync: using ${result.name} (${result.fieldId}).`);
      this.display();
    } else {
      new Notice(`Jira Sync: ${result.message}`);
    }
  }

  private renderAssigneeMappingsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Assignee mappings' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Map Jira assignees (seen on your boards) to Dataview fields like [assignee:: Аряпов]. Open tasks sync assignee both ways; when values differ Obsidian wins. Done↔done tasks are skipped. Unmapped users are ignored.',
    });

    new Setting(containerEl)
      .setName('Load assignees from boards')
      .setDesc(
        'Collect users already assigned on mapped boards (not the full Jira directory). Required before the dropdowns are useful.',
      )
      .addButton((button) =>
        button.setButtonText('Refresh assignees').onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await this.plugin.refreshKnownAssignees();
            if (!result.ok) {
              new Notice(`Jira Sync: ${result.message}`);
              return;
            }
            new Notice(`Jira Sync: loaded ${result.count} assignee(s) from boards.`);
            this.display();
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    const known = this.plugin.settings.knownAssignees ?? [];
    if (known.length === 0) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'No board assignees cached yet. Add note↔board mappings, then click Refresh assignees.',
      });
    }

    const rows = this.plugin.settings.assigneeMappings ?? [];
    rows.forEach((row, index) => {
      new Setting(containerEl)
        .setName(`Assignee ${index + 1}`)
        .setDesc('Jira user → Obsidian Dataview value')
        .addDropdown((dropdown) => {
          dropdown.addOption('', '— select Jira user —');
          for (const user of known) {
            dropdown.addOption(user.accountId, user.displayName);
          }
          // Keep a saved mapping visible even if it is not in the latest refresh.
          if (
            row.jiraAccountId &&
            !known.some((user) => user.accountId === row.jiraAccountId)
          ) {
            dropdown.addOption(
              row.jiraAccountId,
              row.jiraDisplayName || row.jiraAccountId,
            );
          }
          dropdown.setValue(row.jiraAccountId || '');
          dropdown.onChange(async (value) => {
            const current = this.plugin.settings.assigneeMappings[index];
            if (!current) {
              return;
            }
            const match =
              known.find((user) => user.accountId === value) ??
              (value
                ? {
                    accountId: value,
                    displayName: current.jiraDisplayName || value,
                    name: current.jiraName,
                  }
                : null);
            current.jiraAccountId = match?.accountId ?? '';
            current.jiraDisplayName = match?.displayName ?? '';
            current.jiraName = match?.name;
            await this.plugin.saveSettings();
          });
        })
        .addText((text) =>
          text
            .setPlaceholder('Аряпов')
            .setValue(row.obsidianValue)
            .onChange(async (value) => {
              const current = this.plugin.settings.assigneeMappings[index];
              if (!current) {
                return;
              }
              current.obsidianValue = value;
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton((button) => {
          button
            .setIcon('trash')
            .setTooltip('Remove assignee mapping')
            .onClick(async () => {
              this.plugin.settings.assigneeMappings.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            });
        });
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText('Add assignee mapping').onClick(async () => {
        const blank: AssigneeMapping = {
          jiraAccountId: '',
          jiraDisplayName: '',
          obsidianValue: '',
        };
        this.plugin.settings.assigneeMappings.push(blank);
        await this.plugin.savePluginData();
        this.display();
      }),
    );
  }

  private renderMappingsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Note ↔ board mappings' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Each mapping pairs one vault note with one Jira board. Prefer Browse note / Browse board instead of typing ids. Optional Labels filter the board (OR match). Leave Labels empty to sync every issue on the board.',
    });

    this.plugin.settings.mappings.forEach((mapping, index) => {
      new Setting(containerEl)
        .setName(`Mapping ${index + 1} — note`)
        .setDesc('Vault-relative note path — prefer Browse note for the exact Obsidian path')
        .addText((text) =>
          text
            .setPlaceholder('Folder/My tasks.md')
            .setValue(mapping.notePath)
            .onChange(async (value) => {
              const current = this.plugin.settings.mappings[index];
              if (!current) {
                return;
              }
              current.notePath = value;
              await this.plugin.saveSettings();
            }),
        )
        .addButton((button) =>
          button.setButtonText('Browse note').onClick(() => {
            new NoteSuggestModal(this.app, (file) => {
              const current = this.plugin.settings.mappings[index];
              if (!current) {
                return;
              }
              current.notePath = file.path;
              void this.plugin.saveSettings().then(() => this.display());
            }).open();
          }),
        )
        .addExtraButton((button) => {
          button
            .setIcon('trash')
            .setTooltip('Remove mapping')
            .onClick(async () => {
              this.plugin.settings.mappings.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            });
        });

      const boardDesc = mapping.boardName
        ? `Selected: ${mapping.boardName} (id ${mapping.boardId}). Browse board picks project/space, then board.`
        : 'Numeric Agile board id. Prefer Browse board: pick project/space, then board (Cloud and self-hosted).';

      new Setting(containerEl)
        .setName(`Mapping ${index + 1} — board`)
        .setDesc(boardDesc)
        .addText((text) => {
          text.inputEl.type = 'number';
          text.inputEl.min = '1';
          text
            .setPlaceholder('Board id')
            .setValue(mapping.boardId > 0 ? String(mapping.boardId) : '')
            .onChange(async (value) => {
              const current = this.plugin.settings.mappings[index];
              if (!current) {
                return;
              }
              const parsed = Number.parseInt(value, 10);
              const nextId = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
              if (current.boardId !== nextId) {
                current.boardName = undefined;
              }
              current.boardId = nextId;
              await this.plugin.saveSettings();
            });
        })
        .addButton((button) =>
          button.setButtonText('Browse board').onClick(async () => {
            button.setDisabled(true);
            try {
              const result = await this.plugin.listBoards();
              if (!result.ok) {
                new Notice(`Jira Sync: ${result.message}`);
                return;
              }
              openBoardPicker(this.app, result.boards, (board) => {
                void this.applyBoardToMapping(index, board.id, formatBoardSummary(board));
              });
            } finally {
              button.setDisabled(false);
            }
          }),
        );

      new Setting(containerEl)
        .setName(`Mapping ${index + 1} — labels`)
        .setDesc(
          'Comma-separated Jira labels (OR). Empty = all board issues. Type future labels here, or pick ones already on the board.',
        )
        .addText((text) =>
          text
            .setPlaceholder('project-a, backend')
            .setValue(formatLabelList(mapping.labels ?? []))
            .onChange(async (value) => {
              const current = this.plugin.settings.mappings[index];
              if (!current) {
                return;
              }
              current.labels = parseLabelListInput(value);
              await this.plugin.saveSettings();
            }),
        )
        .addButton((button) =>
          button.setButtonText('Add from board').onClick(async () => {
            const current = this.plugin.settings.mappings[index];
            if (!current || !(current.boardId > 0)) {
              new Notice('Jira Sync: choose a board before loading labels.');
              return;
            }
            button.setDisabled(true);
            try {
              const result = await this.plugin.listBoardLabels(current.boardId);
              if (!result.ok) {
                new Notice(`Jira Sync: ${result.message}`);
                return;
              }
              if (result.labels.length === 0) {
                new Notice(
                  'Jira Sync: no labels found (board, backlog, project, or global catalog). Type a label in the field.',
                );
                return;
              }
              new LabelSuggestModal(this.app, result.labels, (label) => {
                void this.addLabelToMapping(index, label);
              }).open();
            } finally {
              button.setDisabled(false);
            }
          }),
        );

      new Setting(containerEl)
        .setName(`Mapping ${index + 1} — recent only`)
        .setDesc(
          'Limit to issues updated or created in the last N days/months. 0 = no limit (Jira search still caps around 1000 issues).',
        )
        .addText((text) => {
          text.inputEl.type = 'number';
          text.inputEl.min = '0';
          text.inputEl.step = '1';
          text
            .setPlaceholder('0')
            .setValue(String(mapping.recencyValue ?? 0))
            .onChange(async (value) => {
              const current = this.plugin.settings.mappings[index];
              if (!current) {
                return;
              }
              const parsed = Number.parseInt(value, 10);
              current.recencyValue = normalizeRecencyValue(
                Number.isFinite(parsed) ? parsed : 0,
              );
              await this.plugin.saveSettings();
            });
        })
        .addDropdown((dropdown) =>
          dropdown
            .addOption('days', 'Days')
            .addOption('months', 'Months')
            .setValue(mapping.recencyUnit ?? 'days')
            .onChange(async (value) => {
              const current = this.plugin.settings.mappings[index];
              if (!current || !isRecencyUnit(value)) {
                return;
              }
              current.recencyUnit = value;
              await this.plugin.saveSettings();
            }),
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption('updated', 'Updated')
            .addOption('created', 'Created')
            .setValue(mapping.recencyField ?? 'updated')
            .onChange(async (value) => {
              const current = this.plugin.settings.mappings[index];
              if (!current || !isRecencyField(value)) {
                return;
              }
              current.recencyField = value;
              await this.plugin.saveSettings();
            }),
        );

      if (!isMappingBlank(mapping) && !isMappingComplete(mapping)) {
        containerEl.createEl('p', {
          cls: 'setting-item-description',
          text: `Mapping ${index + 1} is incomplete — both note and board are required before sync.`,
        });
      } else if (isMappingComplete(mapping)) {
        try {
          const file = resolveMarkdownFile(this.app, mapping.notePath);
          if (file.path !== mapping.notePath) {
            containerEl.createEl('p', {
              cls: 'setting-item-description',
              text: `Resolved to vault path “${file.path}”. Click Browse note once to store that exact path.`,
            });
          }
        } catch {
          containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: `Mapping ${index + 1}: note not found in the vault. Use Browse note to select it.`,
          });
        }
      }
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText('Add mapping').onClick(async () => {
        this.plugin.settings.mappings.push(createEmptyMapping());
        await this.plugin.saveSettings();
        this.display();
      }),
    );
  }

  private async applyBoardToMapping(
    index: number,
    boardId: number,
    boardName: string,
  ): Promise<void> {
    const current = this.plugin.settings.mappings[index];
    if (!current) {
      return;
    }
    current.boardId = boardId;
    current.boardName = boardName;
    await this.plugin.saveSettings();
    new Notice(`Jira Sync: board set to ${boardName} (#${boardId}).`);
    this.display();
  }

  private async addLabelToMapping(index: number, label: string): Promise<void> {
    const current = this.plugin.settings.mappings[index] as NoteBoardMapping | undefined;
    if (!current) {
      return;
    }
    current.labels = normalizeMappingLabels([...(current.labels ?? []), label]);
    await this.plugin.saveSettings();
    this.display();
  }

  private renderConflictSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Conflict policy' });

    new Setting(containerEl)
      .setName('When both sides changed')
      .setDesc('Used when a linked task differs from the last sync on both Obsidian and Jira')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('prefer-obsidian', 'Prefer Obsidian')
          .addOption('prefer-jira', 'Prefer Jira')
          .setValue(this.plugin.settings.conflictPolicy)
          .onChange(async (value) => {
            this.plugin.settings.conflictPolicy = value as ConflictPolicy;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderTriggersSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Sync triggers' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'The Sync now command is always available. These options are independent.',
    });

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Run once after the plugin loads')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Sync on interval')
      .setDesc('Run periodically while Obsidian is open')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncIntervalEnabled)
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Interval value')
      .setDesc('Minimum 1. Combined with the unit below')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text
          .setValue(String(this.plugin.settings.syncIntervalValue))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.syncIntervalValue = normalizeSyncIntervalValue(parsed);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Interval unit')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('minutes', 'Minutes')
          .addOption('hours', 'Hours')
          .setValue(this.plugin.settings.syncIntervalUnit)
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalUnit = value as SyncIntervalUnit;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Sync on file change')
      .setDesc('After editing a mapped note, wait 10 seconds from the last change, then sync')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnFileChange)
          .onChange(async (value) => {
            this.plugin.settings.syncOnFileChange = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Dry-run by default')
      .setDesc(
        'When enabled, Sync now / ribbon only preview changes. Automatic triggers always perform a real sync.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dryRunDefault).onChange(async (value) => {
          this.plugin.settings.dryRunDefault = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderMaintenanceSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Maintenance' });

    const entryCount = Object.keys(this.plugin.ledger.entries).length;
    const pendingCount = this.plugin.pendingLinks.length;

    new Setting(containerEl)
      .setName('Clear sync state')
      .setDesc(
        `Forget the sync ledger and pending links (${entryCount} ledger entr${entryCount === 1 ? 'y' : 'ies'}, ${pendingCount} pending). Connection settings and mappings stay.`,
      )
      .addButton((button) =>
        button
          .setButtonText('Clear sync state')
          .setWarning()
          .onClick(async () => {
            const confirmed = window.confirm(
              'Clear Jira Sync state?\n\n' +
                'This deletes the local sync ledger and pending links. ' +
                'Mapped notes and Jira issues are not deleted. ' +
                'The next sync will treat remote issues as new imports.',
            );
            if (!confirmed) {
              return;
            }
            const cleared = await this.plugin.clearSyncState();
            new Notice(
              cleared > 0
                ? `Jira Sync: cleared sync state (${cleared} record${cleared === 1 ? '' : 's'}).`
                : 'Jira Sync: sync state was already empty.',
            );
            this.display();
          }),
      );
  }
}
