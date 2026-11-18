import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { COPILOT_PROVIDER_ICON } from '../../../shared/icons';
import { copilotModelPolicy } from '../CopilotModelPolicy';

export const copilotChatUIConfig: ProviderChatUIConfig = {
  ...copilotModelPolicy,
  getPermissionModeOptions() {
    return [
      { value: 'normal', label: t('chat.permissionMode.copilot.ask'), description: t('chat.permissionMode.copilot.askDesc') },
      {
        value: 'acceptEdits',
        label: t('chat.permissionMode.copilot.acceptEdits'),
        description: t('chat.permissionMode.copilot.acceptEditsDesc'),
      },
      {
        value: 'yolo',
        label: t('chat.permissionMode.copilot.yolo'),
        description: t('chat.permissionMode.copilot.yoloDesc'),
        bypassesApprovals: true,
      },
    ];
  },
  getProviderIcon() {
    return COPILOT_PROVIDER_ICON;
  },
};
