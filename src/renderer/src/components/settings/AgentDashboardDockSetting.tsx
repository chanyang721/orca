import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { SettingsSwitchRow } from './SettingsFormControls'

export function AgentDashboardDockSetting({
  settings,
  updateSettings,
  compact = false
}: {
  settings: Pick<
    GlobalSettings,
    'experimentalAgentDashboardMode' | 'experimentalAgentDashboardDocked'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
  compact?: boolean
}): React.JSX.Element | null {
  if (settings.experimentalAgentDashboardMode === 'popout') {
    return null
  }

  return (
    <SettingsSwitchRow
      label={translate('dashboardPopout.settings.dockAbove', 'Dock above workspace')}
      description={translate(
        'dashboardPopout.settings.dockAboveCopy',
        'Keep the board visible above your workspace, including when the sidebar is closed.'
      )}
      checked={settings.experimentalAgentDashboardDocked === true}
      onChange={() =>
        updateSettings({
          experimentalAgentDashboardDocked: settings.experimentalAgentDashboardDocked !== true
        })
      }
      className={cn('py-0', compact && '[&_[data-slot=label]]:text-xs [&_p]:text-[11px]')}
    />
  )
}
