window.__ModuleLoader__.load({
  id: 'dsh-losflow-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NAMESPACE = 'losflow-panel';
    const KIND = 'losflow';
    const ID = 'dsh-losflow-panel';
    // 驾驶舱地址：服务端（tools/dashboard/server.mjs）默认监听 8899，面板挂在 /app/
    const PANEL_URL = 'http://127.0.0.1:8899/app/';

    function GuideIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 18,
          height: 18,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 3, y: 4, width: 6, height: 5, rx: 1.2 }),
        h('rect', { x: 15, y: 4, width: 6, height: 5, rx: 1.2 }),
        h('rect', { x: 9, y: 15, width: 6, height: 5, rx: 1.2 }),
        h('path', { d: 'M6 9v3h12V9M12 12v3' })
      );
    }

    function LosFlowBody() {
      return h(
        'div',
        { style: { display: 'flex', flex: '1 1 auto', width: '100%', height: '100%', minHeight: 0 } },
        h('iframe', {
          src: PANEL_URL,
          title: 'LosFlow',
          style: {
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            border: '0',
            display: 'block',
            background: '#0b0b0c',
            colorScheme: 'dark',
          },
        })
      );
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NAMESPACE);

        ctx.effect(
          () =>
            ctx.locale.register(NAMESPACE, {
              zh: {
                'meta.title': 'LosFlow 驾驶舱',
                'meta.description': '在右侧栏里打开 LosFlow 驾驶舱面板。',
                'meta.detail': 'docs/DETAIL.md',
                'type.label': 'LosFlow',
                'guide.title': 'LosFlow',
                'guide.description': '打开驾驶舱面板',
              },
              en: {
                'meta.title': 'LosFlow cockpit',
                'meta.description': 'Opens the LosFlow cockpit panel in the right Sidebar.',
                'meta.detail': 'docs/DETAIL.md',
                'type.label': 'LosFlow',
                'guide.title': 'LosFlow',
                'guide.description': 'Open the cockpit panel',
              },
            }),
          'losflow-panel.copy'
        );

        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: ID,
              kind: KIND,
              priority: 'extension',
              title: () => t('type.label'),
              guide: [
                {
                  id: 'open',
                  kind: KIND,
                  order: 40,
                  title: () => t('guide.title'),
                  description: () => t('guide.description'),
                  icon: GuideIcon,
                },
              ],
            }),
          'losflow-panel.type'
        );

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                { name: 'sidebar.right.pane.tab', key: ID, locale: NAMESPACE },
                LosFlowBody
              )
            ),
          'losflow-panel.body'
        );
      },
    };
  },
});
