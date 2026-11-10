// Exercise the office review components in Node with mocked native adapters and API callbacks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const babel = require('@babel/core');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'mobile/src/OfficeScreens.js'), 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '')
  .replace('export default function OfficeScreens', 'function OfficeScreens');
const { code } = babel.transformSync(source, {
  configFile: false,
  babelrc: false,
  plugins: [require.resolve('@babel/plugin-transform-react-jsx')],
});

let hooks;
function useState(initial) {
  const { state } = hooks;
  const index = hooks.cursor++;
  if (!(index in state)) state[index] = initial;
  return [state[index], value => {
    state[index] = typeof value === 'function' ? value(state[index]) : value;
  }];
}

const OfficeScreens = vm.runInNewContext(`${code}\nOfficeScreens;`, {
  React: {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({
      type, props: props ?? {}, children: children.flat(Infinity),
    }),
  },
  useState,
  useRef: initial => useState({ current: initial })[0],
  useCallback: callback => callback,
  useEffect() {},
  Keyboard: { dismiss() {} },
  Platform: { OS: 'ios' },
  StyleSheet: { create: styles => styles },
  Pressable: 'press',
  ScrollView: 'scroll',
  Text: 'text',
  TextInput: 'input',
  View: 'view',
  Icon: 'icon',
  colors: { blue: '#087CFF' },
  TaskPhotoGallery: 'gallery',
});

function* elements(node) {
  if (!node || typeof node !== 'object') return;
  yield node;
  for (const child of node.children) yield* elements(child);
}

function mount(Component, props) {
  const frame = { state: [], cursor: 0 };
  let tree;
  function render() {
    hooks = frame;
    frame.cursor = 0;
    tree = Component(props);
  }
  render();
  return {
    render,
    find: predicate => [...elements(tree)].find(predicate),
    button(label) {
      const button = this.find(node => node.type?.name === 'Button' && node.children.includes(label));
      assert.ok(button, `Missing button ${label}`);
      return button;
    },
    press(label) {
      const button = this.button(label);
      assert.ok(!button.props.disabled, `Disabled button ${label}`);
      button.props.onPress();
      render();
    },
  };
}

const task = {
  id: '42', title: 'Test task', object: 'Test object', status: 'review',
  checks: [true, true, true, true, true], photos: { before: 1, after: 1 },
};

function openReport(role, status = 'review', updateTask) {
  const updates = [];
  const office = mount(OfficeScreens, {
    role,
    section: 'tasks',
    session: { user: { isOwner: false }, company: { name: 'Test company' } },
    tasks: [{ ...task, status }],
    request: async () => ({ photos: [] }),
    imageSource: () => ({}),
    onUpdateTask: updateTask ?? (async (id, change) => updates.push({ id, ...change })),
  });
  const card = office.find(node => node.type?.name === 'TaskCard' && node.props.task.id === task.id);
  assert.ok(card, 'Task is available in the office list');
  card.props.onPress();
  office.render();
  const review = () => office.find(node => node.type?.name === 'Review');
  const photos = () => office.find(node => node.type === 'gallery' && node.props.kinds.includes('before'));
  const mountReview = () => mount(review().type, review().props);
  return { office, review, photos, mountReview, updates };
}

const flushUpdates = () => new Promise(resolve => setImmediate(resolve));

for (const role of ['dispatcher', 'manager']) {
  test(`${role} can accept submitted work and reject report photos`, async () => {
    const report = openReport(role);
    assert.equal(report.photos().props.canReject, true);
    report.mountReview().press('Принять работу');
    await flushUpdates();
    report.office.render();
    assert.deepEqual(report.updates, [{ id: task.id, status: 'done', reworkReason: '' }]);
    assert.equal(report.review(), undefined);
  });
}

test('dispatcher returns a report with a reason', async () => {
  const report = openReport('dispatcher');
  const review = report.mountReview();
  review.press('Вернуть на доработку');
  assert.equal(review.button('Отправить на доработку').props.disabled, true);
  const input = review.find(node => node.props.accessibilityLabel === 'Причина доработки');
  input.props.onChangeText('  Добавьте чёткое фото  ');
  review.render();
  review.press('Отправить на доработку');
  await flushUpdates();
  assert.deepEqual(report.updates, [{ id: task.id, status: 'rework', reworkReason: 'Добавьте чёткое фото' }]);
});

test('dispatcher has no review actions before submission or after acceptance', () => {
  const arrived = openReport('dispatcher', 'arrived');
  assert.equal(arrived.review(), undefined);
  assert.equal(arrived.photos().props.canReject, false);
  const accepted = openReport('dispatcher', 'done');
  assert.equal(accepted.photos().props.canReject, false);
  assert.equal(accepted.mountReview().find(node => node.type?.name === 'Button'), undefined);
});

test('a failed decision keeps the report open with an error', async () => {
  const message = 'Заявка изменилась';
  const report = openReport('dispatcher', 'review', async () => { throw new Error(message); });
  report.mountReview().press('Принять работу');
  await flushUpdates();
  report.office.render();
  assert.equal(report.review().props.error, message);
});
