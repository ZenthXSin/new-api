import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Input, Button, Switch, Form, Space, message, Typography } from '@base-ui';
import { SettingLayout } from '@/components/SettingLayout';
import { useSetting } from '@/hooks/useSetting';
import { api } from '@/utils/api';

const { Text, Title } = Typography;

interface WeChatPaySetting {
  app_id: string;
  merchant_id: string;
  private_key: string;
  api_v3_key: string;
  enabled: boolean;
  [key: string]: any;
}

const WeChatPaySetting: React.FC = () => {
  const { t } = useTranslation();
  const { setting, loading, updateSetting } = useSetting('payment_wechatpay');
  const [formData, setFormData] = useState<WeChatPaySetting>({
    app_id: '',
    merchant_id: '',
    private_key: '',
    api_v3_key: '',
    enabled: false,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (setting) {
      setFormData({
        app_id: setting.app_id || '',
        merchant_id: setting.merchant_id || '',
        private_key: setting.private_key || '',
        api_v3_key: setting.api_v3_key || '',
        enabled: setting.enabled ?? false,
      });
    }
  }, [setting]);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const data = {
        app_id: formData.app_id,
        merchant_id: formData.merchant_id,
        private_key: formData.private_key,
        api_v3_key: formData.api_v3_key,
        enabled: formData.enabled,
      };
      await updateSetting(data);
      message.success(t('setting.wechatpay.save_success'));
    } catch (error) {
      message.error(t('common.save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingLayout title={t('setting.wechatpay.title')}>
      <Card className="max-w-2xl">
        <div className="space-y-6">
          <Form layout="vertical">
            <Form.Item label={t('setting.wechatpay.app_id')}>
              <Input
                value={formData.app_id}
                onChange={(e) => setFormData({ ...formData, app_id: e.target.value })}
                placeholder="wx1234567890abcdef"
              />
            </Form.Item>

            <Form.Item label={t('setting.wechatpay.merchant_id')}>
              <Input
                value={formData.merchant_id}
                onChange={(e) => setFormData({ ...formData, merchant_id: e.target.value })}
                placeholder="1900009191"
              />
            </Form.Item>

            <Form.Item label={t('setting.wechatpay.private_key')}>
              <Input.TextArea
                value={formData.private_key}
                onChange={(e) => setFormData({ ...formData, private_key: e.target.value })}
                placeholder="-----BEGIN RSA PRIVATE KEY-----..."
                rows={6}
              />
            </Form.Item>

            <Form.Item label={t('setting.wechatpay.api_v3_key')}>
              <Input.TextArea
                value={formData.api_v3_key}
                onChange={(e) => setFormData({ ...formData, api_v3_key: e.target.value })}
                placeholder="-----BEGIN CERTIFICATE-----..."
                rows={6}
              />
            </Form.Item>

            <Form.Item label={t('setting.wechatpay.enabled')}>
              <Switch
                checked={formData.enabled}
                onChange={(checked) => setFormData({ ...formData, enabled: checked })}
              />
            </Form.Item>

            <Space className="mt-6">
              <Button type="primary" onClick={handleSubmit} loading={saving}>
                {t('common.save')}
              </Button>
              <Button onClick={() => window.location.reload()}>
                {t('common.reset')}
              </Button>
            </Space>
          </Form>

          <div className="text-sm text-gray-500">
            <p>{t('setting.wechatpay.note')}</p>
            <ul className="list-disc ml-5 mt-2">
              <li>{t('setting.wechatpay.note1')}</li>
              <li>{t('setting.wechatpay.note2')}</li>
              <li>{t('setting.wechatpay.note3')}</li>
            </ul>
          </div>
        </div>
      </Card>
    </SettingLayout>
  );
};

export default WeChatPaySetting;
