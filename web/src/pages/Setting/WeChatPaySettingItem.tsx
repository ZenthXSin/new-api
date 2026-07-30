import { useTranslation } from 'react-i18next';
import { SettingItem } from '@/components/SettingItem';

const WeChatPaySettingItem: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingItem
      title={t('setting.wechatpay.title')}
      description={t('setting.wechatpay.description')}
      path="payment_wechatpay"
      component={async () => (await import('./WeChatPaySetting')).default}
    />
  );
};

export default WeChatPaySettingItem;
