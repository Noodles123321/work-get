import { defineConfig } from 'wxt';

const HOST_PERMISSIONS = [
  '*://*.zhipin.com/*',
  '*://*.liepin.com/*',
  '*://*.zhaopin.com/*',
  '*://*.yupao.com/*',
  // DSH 桥（本机）：仅用于「推送到 DSH」，请求发往 127.0.0.1
  'http://127.0.0.1/*',
  'http://localhost/*',
];

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Work GET — 求职助手',
    description:
      '在 BOSS直聘 / 猎聘 / 智联招聘 / 鱼泡 浏览时归集岗位，统一去重、匹配打分、半自动投递。所有数据仅存本地。',
    version: '0.1.0',
    permissions: ['storage', 'sidePanel', 'alarms', 'notifications', 'tabs', 'downloads'],
    host_permissions: HOST_PERMISSIONS,
    action: { default_title: 'Work GET' },
  },
  vite: () => ({
    build: {
      // pdfjs 体积较大，放宽告警阈值避免噪音
      chunkSizeWarningLimit: 4096,
    },
  }),
  webExt: {
    // 开发时默认打开侧边栏不方便，先打开一个空白页
    startUrls: ['https://www.zhipin.com/web/geek/job?query=&city=101010100'],
  },
});
