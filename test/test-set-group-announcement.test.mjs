/**
 * test-set-group-announcement.test.mjs — set_group_announcement 离线单测（假 api，无网络）
 *
 * 覆盖：
 *   1. 缺 groupId / title / text → 抛错
 *   2. confirm 不为 true → 返回 confirmRequired，且**一次 fetch 都没发**
 *   3. confirm: true 但 myMember.permissions 不含 group-announcement-manage
 *      → permitted:false 且**没有 POST**
 *   4. 权限 OK + confirm → POST 到 /groups/{gid}/announcement，body 正确、sendNotification 默认 false
 *   5. sendNotification:true + imageId → 透传
 *   6. 工具定义带 destructive:true（安全模式可拦）
 *
 * 用法：node --test test-set-group-announcement.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const GROUP_ID = 'grp_test-0000-0000-0000-000000000001';
const PERM = 'group-announcement-manage';

/** 构造假 api：收集 registerTool 的 def，并记录每一次 fetch 调用 */
function makeApi({ permissions = [PERM], postResult = {} } = {}) {
  const tools = new Map();
  const calls = [];
  const api = {
    vrchat: {
      async fetch(p, opts = {}) {
        calls.push({ path: p, opts });
        if (opts && opts.method === 'POST') return postResult;
        if (p === `/groups/${GROUP_ID}`) return { id: GROUP_ID, myMember: { permissions } };
        return {};
      },
    },
    registerTool(def) { tools.set(def.name, def); },
    consume() { throw new Error('unexpected api.consume call'); },
  };
  return { api, tools, calls };
}

async function setup(opts) {
  const { api, tools, calls } = makeApi(opts);
  const register = (await import(
    pathToFileURL(path.join(REPO, 'plugins', 'official', 'groups', 'index.js')).href
  )).default;
  register(api);
  const def = tools.get('set_group_announcement');
  assert.ok(def, 'set_group_announcement should be registered');
  return { def, calls };
}

test('缺 groupId / title / text 时抛错', async () => {
  const { def } = await setup({});
  await assert.rejects(() => def.handler({ title: 'T', text: 'B' }), /groupId is required/);
  await assert.rejects(() => def.handler({ groupId: GROUP_ID, text: 'B' }), /title is required/);
  await assert.rejects(() => def.handler({ groupId: GROUP_ID, title: 'T' }), /text is required/);
});

test('confirm 不为 true → 返回预览，且一次请求都不发', async () => {
  const { def, calls } = await setup({});
  const r = await def.handler({ groupId: GROUP_ID, title: 'T', text: 'B' });
  assert.equal(r.confirmRequired, true);
  assert.equal(r.posted, undefined);
  assert.equal(calls.length, 0, 'confirm 缺失时不允许发出任何请求');
});

test('有 confirm 但无 group-announcement-manage → permitted:false 且不发 POST', async () => {
  const { def, calls } = await setup({ permissions: ['group-members-viewall', 'group-instance-join'] });
  const r = await def.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true });
  assert.equal(r.permitted, false);
  assert.equal(r.posted, false);
  const posts = calls.filter((c) => c.opts && c.opts.method === 'POST');
  assert.equal(posts.length, 0, '权限不足时不允许发 POST');
  // 自查权限这一步是只读的 GET
  assert.deepEqual(calls.map((c) => c.path), [`/groups/${GROUP_ID}`]);
});

test('权限 OK + confirm → POST 到 announcement，sendNotification 默认 false、不带 imageId', async () => {
  const { def, calls } = await setup({
    postResult: { id: 'not_1', title: 'T', text: 'B', authorId: 'usr_x', createdAt: 'c', updatedAt: 'u' },
  });
  const r = await def.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true });
  assert.equal(r.posted, true);
  assert.equal(r.announcement.id, 'not_1');
  assert.equal(r.announcement.title, 'T');

  const post = calls.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(post, '应当发出 POST');
  assert.equal(post.path, `/groups/${GROUP_ID}/announcement`);
  // body 必须是**对象**：api.vrchat.fetch → _requestRaw 内部已 JSON.stringify，
  // 这里再串化一次 = 双重编码（服务端收到字符串字面量）—— 实测踩过。
  assert.equal(typeof post.opts.body, 'object', 'body 必须是对象，不能是已序列化的字符串');
  assert.equal(Array.isArray(post.opts.body), false, 'body 不应是数组');
  const body = post.opts.body;
  assert.equal(body.title, 'T');
  assert.equal(body.text, 'B');
  assert.equal(body.sendNotification, false);
  assert.equal('imageId' in body, false, '未提供 imageId 时不应带该字段');
});

test('sendNotification:true 与 imageId 透传', async () => {
  const { def, calls } = await setup({ postResult: { id: 'not_2' } });
  await def.handler({
    groupId: GROUP_ID, title: 'T', text: 'B',
    imageId: 'file_abc', sendNotification: true, confirm: true,
  });
  const post = calls.find((c) => c.opts && c.opts.method === 'POST');
  const body = post.opts.body;
  assert.equal(body.sendNotification, true);
  assert.equal(body.imageId, 'file_abc');
});

test('工具定义合法且带 destructive:true', async () => {
  const { def } = await setup({});
  assert.equal(def.destructive, true);
  assert.equal(typeof def.description, 'string');
  assert.equal(def.inputSchema.type, 'object');
  assert.deepEqual(def.inputSchema.required, ['groupId', 'title', 'text']);
  assert.equal(typeof def.handler, 'function');
});
