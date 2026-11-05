import { useTranslation } from 'react-i18next';

import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useTheme } from '@/shared/context/ThemeContext';
import type { AppearanceStyle, CodeEditorSettingsState, ProjectSortOrder, ThemeMode } from '@/shared/types';
import { APPEARANCE_STYLES } from '@/shared/constants';
import { LanguageSelector } from '@/modules/i18n';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

const STYLE_DETAILS: Record<AppearanceStyle, { label: string; description: string; fonts?: string }> = {
  claude: { label: 'Claude', description: 'Warm surfaces, terracotta accents and serif type.' },
  github: { label: 'GitHub', description: 'Neutral surfaces, fine borders and system type.' },
  linear: { label: 'Linear', description: 'Frosted surfaces, soft blue-violet light and geometric type.', fonts: 'Manrope · MiSans for Chinese · JetBrains Mono for code' },
  paper: { label: 'Paper', description: 'A warm reading sheet, ink accents and book typography.', fonts: 'Newsreader · Source Han Serif for Chinese · JetBrains Mono for code' },
  raycast: { label: 'Raycast', description: 'Compact command panels, graphite surfaces and coral accents.', fonts: 'IBM Plex Sans · IBM Plex Sans SC · IBM Plex Mono' },
};

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

/** Rendered by Settings for the "appearance" tab, covering theme, project sorting and code editor preferences. */
export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { themeMode, setThemeMode, chatFontSize, setChatFontSize, appearanceStyle, setAppearanceStyle } = useTheme();
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.style.label', { defaultValue: 'Interface style' })}>
        <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label={t('appearanceSettings.style.label', { defaultValue: 'Interface style' })}>
          {APPEARANCE_STYLES.map(style => (
            <label key={style} className={`appearance-style-option relative cursor-pointer rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring ${appearanceStyle === style ? 'border-ring bg-accent/30' : 'border-border bg-card hover:bg-muted/40'}`}>
              <input type="radio" name="interface-style" value={style} aria-label={t(`appearanceSettings.style.${style}Label`, { defaultValue: STYLE_DETAILS[style].label })}
                checked={appearanceStyle === style} onChange={() => setAppearanceStyle(style)} className="peer sr-only" />
              <span aria-hidden="true" className="appearance-style-preview" data-preview={style}>
                <span className="appearance-preview-sidebar"><i /><i /><i /></span>
                <span className="appearance-preview-main">
                  {style === 'paper' || style === 'raycast'
                    ? <span className="appearance-preview-type">{style === 'paper' ? 'Aa 书' : '⌘ K'}</span>
                    : <i />}
                  <i /><i />
                </span>
              </span>
              <span className="mt-2.5 flex items-center justify-between gap-2 text-sm font-semibold">
                {t(`appearanceSettings.style.${style}Label`, { defaultValue: STYLE_DETAILS[style].label })}<span aria-hidden="true" className={`h-3.5 w-3.5 rounded-full border ${appearanceStyle === style ? 'border-ring bg-ring shadow-[inset_0_0_0_3px_hsl(var(--card))]' : 'border-input'}`} />
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {t(`appearanceSettings.style.${style}Description`, { defaultValue: STYLE_DETAILS[style].description })}
              </span>
            </label>
          ))}
        </div>
        {STYLE_DETAILS[appearanceStyle].fonts && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t(`appearanceSettings.style.${appearanceStyle}Fonts`, { defaultValue: STYLE_DETAILS[appearanceStyle].fonts })}</p>}
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.theme.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.theme.label')}
            description={t('appearanceSettings.theme.description')}
          >
            <select
              value={themeMode}
              onChange={(event) => setThemeMode(event.target.value as ThemeMode)}
              aria-label={t('appearanceSettings.theme.label')}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="light">{t('appearanceSettings.theme.light')}</option>
              <option value="dark">{t('appearanceSettings.theme.dark')}</option>
              <option value="system">{t('appearanceSettings.theme.system')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.chat.title', { defaultValue: 'Chat' })}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.chat.fontSize.label', { defaultValue: 'Chat font size' })}
            description={t('appearanceSettings.chat.fontSize.description', { defaultValue: 'Text size for chat messages (px)' })}
          >
            <select
              value={chatFontSize}
              onChange={(event) => setChatFontSize(event.target.value)}
              aria-label={t('appearanceSettings.chat.fontSize.label', { defaultValue: 'Chat font size' })}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="theme">{t('appearanceSettings.chat.fontSize.theme', { defaultValue: 'Theme default' })}</option>
              {[8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24].map(size => <option key={size} value={size}>{size}px</option>)}
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.keepProjectsExpanded.section', { defaultValue: 'Sidebar' })}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.keepProjectsExpanded.label', { defaultValue: 'Keep projects expanded' })}
            description={t('appearanceSettings.keepProjectsExpanded.description', { defaultValue: 'Open several projects together and remember them after reloading.' })}
          >
            <SettingsToggle
              checked={preferences.keepProjectsExpanded}
              onChange={(value) => setPreference('keepProjectsExpanded', value)}
              ariaLabel={t('appearanceSettings.keepProjectsExpanded.label', { defaultValue: 'Keep projects expanded' })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              aria-label={t('appearanceSettings.codeEditor.fontSize.label')}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
            >
              <option value="8">8px</option>
              <option value="9">9px</option>
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
