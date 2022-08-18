import {normalizePath, App, Editor, EventRef, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, addIcon, EditorChange} from 'obsidian';
import {LinterSettings, getDisabledRules, rules} from './rules';
import DiffMatchPatch from 'diff-match-patch';
import dedent from 'ts-dedent';
import {stripCr} from './utils/strings';
import log from 'loglevel';
import {logInfo, logError, logDebug, setLogLevel} from './logger';
import {moment} from 'obsidian';
import './rules-registry';
import EscapeYamlSpecialCharacters from './rules/escape-yaml-special-characters';
import FormatTagsInYaml from './rules/format-tags-in-yaml';
import YamlTimestamp from './rules/yaml-timestamp';
import YamlKeySort from './rules/yaml-key-sort';
import {RuleBuilderBase} from './rules/rule-builder';
import {iconInfo} from './icons';
import {YAMLException} from 'js-yaml';

declare global {
  // eslint-disable-next-line no-unused-vars
  interface Window {
    CodeMirrorAdapter: {
      commands: {
        save(): void;
      }
    };
  }
}

// allows for the removal of the any cast by defining some extra properties for Typescript so it knows these properties exist
declare module 'obsidian' {
  // eslint-disable-next-line no-unused-vars
  interface App {
    commands: {
        executeCommandById(id: string): void;
        commands: {
            'editor:save-file': {
                callback(): void;
            };
        };
    };
  }
}

// https://github.com/liamcain/obsidian-calendar-ui/blob/03ceecbf6d88ef260dadf223ee5e483d98d24ffc/src/localization.ts#L20-L43
const langToMomentLocale = {
  'en': 'en-gb',
  'zh': 'zh-cn',
  'zh-TW': 'zh-tw',
  'ru': 'ru',
  'ko': 'ko',
  'it': 'it',
  'id': 'id',
  'ro': 'ro',
  'pt-BR': 'pt-br',
  'cz': 'cs',
  'da': 'da',
  'de': 'de',
  'es': 'es',
  'fr': 'fr',
  'no': 'nn',
  'pl': 'pl',
  'pt': 'pt',
  'tr': 'tr',
  'hi': 'hi',
  'nl': 'nl',
  'ar': 'ar',
  'ja': 'ja',
};

export default class LinterPlugin extends Plugin {
  settings: LinterSettings;
  private eventRef: EventRef;
  private momentLocale: string;

  async onload() {
    logInfo('Loading plugin');

    // eslint-disable-next-line guard-for-in
    for (const key in iconInfo) {
      const svg = iconInfo[key];
      addIcon(svg.id, svg.source);
    }

    await this.loadSettings();

    this.addCommand({
      id: 'lint-file',
      name: 'Lint the current file',
      editorCallback: (editor) => this.runLinterEditor(editor),
      icon: iconInfo.file.id,
      hotkeys: [
        {
          modifiers: ['Mod', 'Alt'],
          key: 'l',
        },
      ],
    });

    this.addCommand({
      id: 'lint-all-files',
      name: 'Lint all files in the vault',
      icon: iconInfo.vault.id,
      callback: () => {
        const startMessage = 'This will edit all of your files and may introduce errors.';
        const submitBtnText = 'Lint All';
        const submitBtnNoticeText = 'Linting all files...';
        new LintConfirmationModal(this.app, startMessage, submitBtnText, submitBtnNoticeText, () =>{
          return this.runLinterAllFiles(this.app);
        }).open();
      },
    });

    this.addCommand({
      id: 'lint-all-files-in-folder',
      name: 'Lint all files in the current folder',
      icon: iconInfo.folder.id,
      editorCheckCallback: (checking: Boolean, _) => {
        if (checking) {
          return !this.app.workspace.getActiveFile().parent.isRoot();
        }

        this.createFolderLintModal(this.app.workspace.getActiveFile().parent);
      },
    });

    // https://github.com/mgmeyers/obsidian-kanban/blob/main/src/main.ts#L239-L251
    this.registerEvent(
        this.app.workspace.on('file-menu', (menu, file: TFile) => {
        // Add a menu item to the folder context menu to create a board
          if (file instanceof TFolder) {
            menu.addItem((item) => {
              item
                  .setTitle('Lint folder')
                  .setIcon(iconInfo.folder.id)
                  .onClick(() => this.createFolderLintModal(file));
            });
          }
        }),
    );

    this.eventRef = this.app.workspace.on('file-menu',
        (menu, file, source) => this.onMenuOpenCallback(menu, file, source));
    this.registerEvent(this.eventRef);

    // Source for save setting
    // https://github.com/hipstersmoothie/obsidian-plugin-prettier/blob/main/src/main.ts
    const saveCommandDefinition = this.app.commands?.commands?.[
      'editor:save-file'
    ];
    const save = saveCommandDefinition?.callback;

    if (typeof save === 'function') {
      saveCommandDefinition.callback = () => {
        if (this.settings.lintOnSave) {
          const editor = this.app.workspace.getActiveViewOfType(MarkdownView).editor;
          const file = this.app.workspace.getActiveFile();

          if (!this.shouldIgnoreFile(file)) {
            this.runLinterEditor(editor);
          }
        }
      };
    }

    // defines the vim command for saving a file and lets the linter run on save for it
    // accounts for https://github.com/platers/obsidian-linter/issues/19
    const that = this;
    window.CodeMirrorAdapter.commands.save = () => {
      that.app.commands.executeCommandById('editor:save-file');
    };

    this.addSettingTab(new SettingTab(this.app, this));
  }

  async onunload() {
    logInfo('Unloading plugin');
    this.app.workspace.offref(this.eventRef);
  }

  async loadSettings() {
    this.settings = {
      ruleConfigs: {},
      lintOnSave: false,
      displayChanged: true,
      foldersToIgnore: [],
      linterLocale: 'system-default',
      logLevel: log.levels.ERROR,
    };
    const data = await this.loadData();
    const storedSettings = data || {};

    for (const rule of rules) {
      this.settings.ruleConfigs[rule.name] = rule.getDefaultOptions();
      if (storedSettings?.ruleConfigs && storedSettings?.ruleConfigs[rule.name]) {
        Object.assign(this.settings.ruleConfigs[rule.name], storedSettings.ruleConfigs[rule.name]);

        // For backwards compatibility, if enabled is set, copy it to the new option and remove it
        if (storedSettings.ruleConfigs[rule.name].Enabled !== undefined) {
          const newEnabledOptionName = rule.enabledOptionName();
          this.settings.ruleConfigs[rule.name][newEnabledOptionName] = storedSettings.ruleConfigs[rule.name].Enabled;
          delete this.settings.ruleConfigs[rule.name].Enabled;
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(storedSettings, 'lintOnSave')) {
      this.settings.lintOnSave = storedSettings.lintOnSave;
    }
    if (Object.prototype.hasOwnProperty.call(storedSettings, 'displayChanged')) {
      this.settings.displayChanged = storedSettings.displayChanged;
    }
    if (Object.prototype.hasOwnProperty.call(storedSettings, 'foldersToIgnore')) {
      this.settings.foldersToIgnore = storedSettings.foldersToIgnore;
    }
    if (Object.prototype.hasOwnProperty.call(storedSettings, 'linterLocale')) {
      this.settings.linterLocale = storedSettings.linterLocale;
    }
    if (Object.prototype.hasOwnProperty.call(storedSettings, 'logLevel')) {
      this.settings.logLevel = storedSettings.logLevel;
    }

    setLogLevel(this.settings.logLevel);
    this.setOrUpdateMomentInstance();
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  onMenuOpenCallback(menu: Menu, file: TAbstractFile, source: string) {
    if (file instanceof TFile && file.extension === 'md') {
      menu.addItem((item) => {
        item.setIcon(iconInfo.file.id);
        item.setTitle('Lint file');
        item.onClick(async (evt) => {
          this.runLinterFile(file);
        });
      });
    }
  }

  lintText(oldText: string, file: TFile) {
    let newText = oldText;

    const disabledRules = getDisabledRules(newText);
    // remove hashtags from tags before parsing yaml
    [newText] = FormatTagsInYaml.applyIfEnabled(newText, this.settings, disabledRules);

    // escape YAML where possible before parsing yaml
    [newText] = EscapeYamlSpecialCharacters.applyIfEnabled(newText, this.settings, disabledRules);

    const createdAt = moment(file.stat.ctime);
    createdAt.locale(this.momentLocale);
    const modifiedAt = moment(file.stat.mtime);
    modifiedAt.locale(this.momentLocale);
    const modifiedAtTime = modifiedAt.format();
    const createdAtTime = createdAt.format();

    for (const rule of rules) {
      // if you are run prior to or after the regular rules or are a disabled rule, skip running the rule
      if (disabledRules.includes(rule.alias())) {
        logDebug(rule.alias() + ' is disabled');
        continue;
      } else if (rule.hasSpecialExecutionOrder) {
        continue;
      }

      [newText] = RuleBuilderBase.applyIfEnabledBase(rule, newText, this.settings, {
        fileCreatedTime: createdAtTime,
        fileModifiedTime: modifiedAtTime,
        fileName: file.basename,
        locale: this.momentLocale,
      });
    }

    let currentTime = moment();
    currentTime.locale(this.momentLocale);
    // run yaml timestamp at the end to help determine if something has changed
    let isYamlTimestampEnabled;
    [newText, isYamlTimestampEnabled] = YamlTimestamp.applyIfEnabled(newText, this.settings, disabledRules, {
      fileCreatedTime: createdAtTime,
      fileModifiedTime: modifiedAtTime,
      currentTime: currentTime,
      alreadyModified: oldText != newText,
      locale: this.momentLocale,
    });

    const yamlTimestampOptions = YamlTimestamp.getRuleOptions(this.settings);

    currentTime = moment();
    currentTime.locale(this.momentLocale);
    [newText] = YamlKeySort.applyIfEnabled(newText, this.settings, disabledRules, {
      currentTimeFormatted: currentTime.format(yamlTimestampOptions.format),
      yamlTimestampDateModifiedEnabled: isYamlTimestampEnabled && yamlTimestampOptions.dateModified,
      dateModifiedKey: yamlTimestampOptions.dateModifiedKey,
    });

    return newText;
  }

  shouldIgnoreFile(file: TFile) {
    for (const folder of this.settings.foldersToIgnore) {
      if (folder.length > 0 && file.path.startsWith(folder)) {
        return true;
      }
    }
    return false;
  }

  async runLinterFile(file: TFile) {
    const oldText = stripCr(await this.app.vault.read(file));
    const newText = this.lintText(oldText, file);

    await this.app.vault.modify(file, newText);
  }

  async runLinterAllFiles(app: App) {
    let numberOfErrors = 0;
    await Promise.all(app.vault.getMarkdownFiles().map(async (file) => {
      if (!this.shouldIgnoreFile(file)) {
        try {
          await this.runLinterFile(file);
        } catch (error) {
          this.handleLintError(file, error, 'There is an error in the yaml of file \'${file.path}\': ', 'Lint All Files Error in File \'${file.path}\'');

          numberOfErrors+=1;
        }
      }
    }));
    if (numberOfErrors === 0) {
      new Notice('Linted all files');
    } else {
      const amountOfErrorsMessage = numberOfErrors === 1 ? 'was 1 error': 'were ' + numberOfErrors + ' errors';
      new Notice('Linted all files and there ' + amountOfErrorsMessage + '.');
    }
  }

  async runLinterAllFilesInFolder(folder: TFolder) {
    logInfo('Linting folder ' + folder.name);

    let numberOfErrors = 0;
    let lintedFiles = 0;
    const folderPath = normalizePath(folder.path) + '/';
    await Promise.all(this.app.vault.getMarkdownFiles().map(async (file) => {
      if (normalizePath(file.path).startsWith(folderPath) && !this.shouldIgnoreFile(file)) {
        try {
          await this.runLinterFile(file);
        } catch (error) {
          this.handleLintError(file, error, 'There is an error in the yaml of file \'${file.path}\': ', 'Lint All Files in Folder Error in File \'${file.path}\'');

          numberOfErrors+=1;
        }

        lintedFiles++;
      }
    }));
    if (numberOfErrors === 0) {
      new Notice('Linted all ' + lintedFiles + ' files in ' + folder.name + '.');
    } else {
      const amountOfErrorsMessage = numberOfErrors === 1 ? 'was 1 error': 'were ' + numberOfErrors + ' errors';
      new Notice('Linted all ' + lintedFiles + ' files in ' + folder.name + ' and there ' + amountOfErrorsMessage + '.');
    }
  }

  // handles the creation of the folder linting modal since this happens in multiple places and it should be consistent
  createFolderLintModal(folder: TFolder) {
    const startMessage = 'This will edit all of your files in ' + folder.name + ' including files in its subfolders which may introduce errors.';
    const submitBtnText = 'Lint All Files in ' + folder.name;
    const submitBtnNoticeText = 'Linting all files in ' + folder.name + '...';
    new LintConfirmationModal(this.app, startMessage, submitBtnText, submitBtnNoticeText, () => this.runLinterAllFilesInFolder(folder)).open();
  }

  runLinterEditor(editor: Editor) {
    logInfo('Running linter');

    const file = this.app.workspace.getActiveFile();
    const oldText = editor.getValue();
    let newText: string;
    try {
      newText = this.lintText(oldText, file);
    } catch (error) {
      this.handleLintError(file, error, 'There is an error in the yaml: ', 'Lint File Error in File \'${file.path}\'');
    }

    // Replace changed lines
    const dmp = new DiffMatchPatch.diff_match_patch(); // eslint-disable-line new-cap
    const changes = dmp.diff_main(oldText, newText);
    const editorChange: EditorChange[] = [];
    let curText = '';
    changes.forEach((change) => {
      function endOfDocument(doc: string) {
        const lines = doc.split('\n');
        return {line: lines.length - 1, ch: lines[lines.length - 1].length};
      }

      const [type, value] = change;

      if (type == DiffMatchPatch.DIFF_INSERT) {

        editorChange.push({
          text: value,
          from: endOfDocument(curText),
        });
        
        curText += value;
      } else if (type == DiffMatchPatch.DIFF_DELETE) {
        const start = endOfDocument(curText);
        let tempText = curText;
        tempText += value;
        const end = endOfDocument(tempText);

        editorChange.push({
          text: '',
          from: start,
          to: end,
        });

      } else {
        curText += value;
      }
    });

    editor.transaction({
      changes: editorChange,
    });

    const charsAdded = changes.map((change) => change[0] == DiffMatchPatch.DIFF_INSERT ? change[1].length : 0).reduce((a, b) => a + b, 0);
    const charsRemoved = changes.map((change) => change[0] == DiffMatchPatch.DIFF_DELETE ? change[1].length : 0).reduce((a, b) => a + b, 0);
    this.displayChangedMessage(charsAdded, charsRemoved);
  }

  // based on https://github.com/liamcain/obsidian-calendar-ui/blob/03ceecbf6d88ef260dadf223ee5e483d98d24ffc/src/localization.ts#L85-L109
  async setOrUpdateMomentInstance() {
    const obsidianLang: string = localStorage.getItem('language') || 'en';
    const systemLang = navigator.language?.toLowerCase();

    let momentLocale = langToMomentLocale[obsidianLang as keyof typeof langToMomentLocale];

    if (this.settings.linterLocale !== 'system-default') {
      momentLocale = this.settings.linterLocale;
    } else if (systemLang.startsWith(obsidianLang)) {
      // If the system locale is more specific (en-gb vs en), use the system locale.
      momentLocale = systemLang;
    }

    this.momentLocale = momentLocale;
    const oldLocale = moment.locale();
    const currentLocale = moment.locale(momentLocale);
    logDebug(`Trying to switch Moment.js locale to ${momentLocale}, got ${currentLocale}`);

    moment.locale(oldLocale);
  }

  private displayChangedMessage(charsAdded: number, charsRemoved: number) {
    if (this.settings.displayChanged) {
      const message = dedent`
        ${charsAdded} characters added
        ${charsRemoved} characters removed
      `;
      new Notice(message);
    }
  }

  private handleLintError(file: TFile, error: Error, yamlErrorStringTemplate: string, logErrorStringTemplate: string) {
    if (error instanceof YAMLException) {
      let errorMessage = error.toString();
      errorMessage = errorMessage.substring(errorMessage.indexOf(':') + 1);

      new Notice(yamlErrorStringTemplate.replace('${file.path}', file.path) + errorMessage);
    } else {
      new Notice('An error occurred during linting. See console for details');
    }

    logError(logErrorStringTemplate.replace('${file.path}', file.path), error);
  }
}

class SettingTab extends PluginSettingTab {
  plugin: LinterPlugin;

  constructor(app: App, plugin: LinterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;

    containerEl.empty();

    containerEl.createEl('h2', {text: 'General Settings'});

    new Setting(containerEl)
        .setName('Lint on save')
        .setDesc('Lint the file on manual save (when `Ctrl + S` is pressed or when `:w` is executed while using vim keybindings)')
        .addToggle((toggle) => {
          toggle
              .setValue(this.plugin.settings.lintOnSave)
              .onChange(async (value) => {
                this.plugin.settings.lintOnSave = value;
                await this.plugin.saveSettings();
              });
        });

    new Setting(containerEl)
        .setName('Display message on lint')
        .setDesc('Display the number of characters changed after linting')
        .addToggle((toggle) => {
          toggle
              .setValue(this.plugin.settings.displayChanged)
              .onChange(async (value) => {
                this.plugin.settings.displayChanged = value;
                await this.plugin.saveSettings();
              });
        });

    new Setting(containerEl)
        .setName('Folders to ignore')
        .setDesc('Folders to ignore when linting all files or linting on save. Enter folder paths separated by newlines')
        .addTextArea((textArea) => {
          textArea
              .setValue(this.plugin.settings.foldersToIgnore.join('\n'))
              .onChange(async (value) => {
                this.plugin.settings.foldersToIgnore = value.split('\n');
                await this.plugin.saveSettings();
              });
        });

    this.addLocaleOverrideSetting();

    let prevSection = '';

    for (const rule of rules) {
      if (rule.type !== prevSection) {
        containerEl.createEl('h2', {text: rule.type});
        prevSection = rule.type;
      }

      containerEl.createEl('h3', {}, (el) =>{
        el.innerHTML = `<a href="${rule.getURL()}">${rule.name}</a>`;
      });

      for (const option of rule.options) {
        option.display(containerEl, this.plugin.settings, this.plugin);
      }
    }
  }

  addLocaleOverrideSetting(): void {
    const sysLocale = navigator.language?.toLowerCase();

    new Setting(this.containerEl)
        .setName('Override locale:')
        .setDesc(
            'Set this if you want to use a locale different from the default',
        )
        .addDropdown((dropdown) => {
          dropdown.addOption('system-default', `Same as system (${sysLocale})`);
          moment.locales().forEach((locale) => {
            dropdown.addOption(locale, locale);
          });
          dropdown.setValue(this.plugin.settings.linterLocale);
          dropdown.onChange(async (value) => {
            this.plugin.settings.linterLocale = value;
            await this.plugin.setOrUpdateMomentInstance();
            await this.plugin.saveSettings();
          });
        });
  }
}

// https://github.com/nothingislost/obsidian-workspaces-plus/blob/bbba928ec64b30b8dec7fe8fc9e5d2d96543f1f3/src/modal.ts#L68
class LintConfirmationModal extends Modal {
  constructor(app: App, startModalMessageText: string, submitBtnText: string,
      submitBtnNoticeText: string, btnSubmitAction: () => Promise<void>) {
    super(app);
    this.modalEl.addClass('confirm-modal');

    this.contentEl.createEl('h3', {text: 'Warning'});

    const e: HTMLParagraphElement = this.contentEl.createEl('p',
        {text: startModalMessageText + ' Make sure you have backed up your files.'});
    e.id = 'confirm-dialog';

    this.contentEl.createDiv('modal-button-container', (buttonsEl) => {
      buttonsEl.createEl('button', {text: 'Cancel'}).addEventListener('click', () => this.close());

      const btnSubmit = buttonsEl.createEl('button', {
        attr: {type: 'submit'},
        cls: 'mod-cta',
        text: submitBtnText,
      });
      btnSubmit.addEventListener('click', async (e) => {
        new Notice(submitBtnNoticeText);
        this.close();
        await btnSubmitAction();
      });
      setTimeout(() => {
        btnSubmit.focus();
      }, 50);
    });
  }
}
