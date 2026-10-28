/*
 * Hermes Vitals Light — dashboard page (hidden tab `/vitals`).
 *
 * The figures live in the Desktop status bar and the TUI card; this page exists
 * so the dashboard has a registered bundle to load beside `plugin_api.py`
 * instead of asking the server for a `dist/index.js` that is not there. It is
 * not in the sidebar (`tab.hidden`) and is reachable directly at `/vitals`.
 */
;(() => {
  const sdk = window.__HERMES_PLUGIN_SDK__
  const registry = window.__HERMES_PLUGINS__

  if (!sdk?.React || typeof registry?.register !== 'function') {
    return
  }

  const h = sdk.React.createElement

  const paragraph = (children, style) => h('p', { style: { margin: 0, ...style } }, children)

  function VitalsPage() {
    return h(
      'div',
      {
        style: {
          display: 'grid',
          gap: '1rem',
          maxWidth: '40rem',
          padding: '1.5rem',
          color: 'var(--ui-text-secondary)',
          fontSize: '0.875rem',
          lineHeight: 1.5
        }
      },
      h('div', { style: { display: 'grid', gap: '0.375rem' } }, [
        h('h1', { style: { color: 'var(--ui-text)', fontSize: '1.125rem', fontWeight: 600, margin: 0 } }, 'Hermes Vitals Light'),
        paragraph(
          'CPU, load average, free RAM and CPU pressure of the connected server are shown as a chip in the Hermes Desktop status bar.'
        )
      ]),
      h(
        'div',
        {
          style: {
            border: '1px solid var(--ui-stroke-secondary)',
            borderRadius: '0.5rem',
            display: 'grid',
            gap: '0.5rem',
            padding: '1rem'
          }
        },
        [
          paragraph('Desktop: enable Capabilities → Plugins → Hermes Vitals Light, then look at the status bar.'),
          paragraph('TUI: copy tui/hermes-vitals-light.mjs to <HERMES_HOME>/tui-widgets/ and run /vitals.'),
          paragraph('This page is hidden; it only gives the dashboard a bundle to load for the /stats backend route.', {
            color: 'var(--ui-text-tertiary)',
            fontSize: '0.75rem'
          })
        ]
      )
    )
  }

  registry.register('hermes-vitals-light', VitalsPage)
})()
