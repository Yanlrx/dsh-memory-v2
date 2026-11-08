window.__ModuleLoader__.load({
  id: 'dsh-memory-v2',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-memory-v2#memory-v2',
        }, (ownerProps) => {
          if (ownerProps.view !== 'page' || !ownerProps.form) return null;
          const form = ownerProps.form;
          const value = Boolean(form.state && form.state['语义召回']);
          return h('div', {},
            h('span', {}, '语义召回'),
            h(primitives.Switch, {
              checked: value,
              onChange: (next) => {
                form.mutate({ 语义召回: next }, form.state);
              },
            }),
          );
        }));
      },
    };
  },
});
