const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleSalaryCommand } = require('../src/commands/salaries');
const { getTownJobOptions } = require('../src/commands/townJobs');
const { calculateSalary, processTownJobsSalaries, salaryIntervalMs } = require('../src/services/economySalaries');
const { setConfigValue } = require('../src/utils/discord');

const managerRoleId = '1556064708795306157';
const managerId = 'salary-manager';
const roleA = '1666064708795306156';
const roleB = '1666064708795306157';
const staleRole = '1666064708795306158';

function makeTempDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-salaries-'));
  const filename = path.join(directory, 'salaries.sqlite');
  let db = createDatabase(filename);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get db() { return db; },
    reopen() {
      db.close();
      db = createDatabase(filename);
      return db;
    },
  };
}

function makeMember(id, roleIds) {
  return { id, roles: { cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])) } };
}

function createGuild(memberList) {
  return {
    id: config.SERVER_ID,
    members: { fetch: async () => new Map(memberList.map((member) => [member.id, member])) },
  };
}

function seedTownJob(db, roleIds = [roleA, roleB]) {
  setConfigValue(db, 'TOWN_JOBS_ROLE_OPTIONS', roleIds.map((roleId, index) => ({
    id: `a1b2c3d${index}`,
    roleId,
    label: `Job ${index + 1}`,
    description: '',
    emoji: '',
    action: 'give',
    style: 'primary',
  })));
}

function addSalary(db, roleId, amount, enabled = 1) {
  db.prepare(`
    INSERT INTO economy_job_salaries (role_id, salary, enabled, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(roleId, amount, enabled, managerId, '2026-10-31T00:00:00.000Z');
}

function commandInteraction(db, action, options = {}, userId = managerId) {
  let lastReply;
  const manager = { id: managerId, roles: { cache: new Map([[managerRoleId, { id: managerRoleId, name: 'Admin' }]]) } };
  const member = userId === managerId ? manager : { id: userId, roles: { cache: new Map() } };
  const guild = { ownerId: 'owner', members: { fetch: async () => member } };
  return {
    commandName: 'salary',
    guild,
    user: { id: userId, username: userId },
    options: { getSubcommand: () => action, ...options },
    reply: async (payload) => { lastReply = payload; return payload; },
    get lastReply() { return lastReply; },
  };
}

test('highest policy selects the lower numeric role when salaries are tied', () => {
  const roles = [
    { role_id: '20000000000000000', salary: 100 },
    { role_id: '100000000000000000', salary: 100 },
    { role_id: '30000000000000000', salary: 90 },
  ];
  const winner = calculateSalary(roles, 'highest');
  assert.equal(winner.role_id, '20000000000000000');
});

test('Town Jobs salaries start after 30 minutes and pay once per due schedule across restarts', async (t) => {
  const store = makeTempDatabase(t);
  const { db } = store;
  seedTownJob(db);
  addSalary(db, roleA, 120);
  addSalary(db, roleB, 80);
  addSalary(db, staleRole, 999);
  setConfigValue(db, 'ECONOMY_STARTING_BALANCE', 500);
  const member = makeMember('salary-player', [roleA, roleB, staleRole]);
  const guild = createGuild([member]);
  const client = { guilds: { cache: new Map([[config.SERVER_ID, guild]]) } };
  const start = new Date('2026-10-31T12:00:00.000Z');

  assert.deepEqual(getTownJobOptions(db).map((job) => job.roleId), [roleA, roleB]);
  assert.equal(await processTownJobsSalaries(client, db, start), 0);
  let schedule = db.prepare('SELECT * FROM economy_salary_schedules WHERE user_id = ?').get(member.id);
  assert.equal(schedule.next_due_at, new Date(start.getTime() + salaryIntervalMs).toISOString());
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'salary'").get().count, 0);

  assert.equal(await processTownJobsSalaries(client, db, new Date(start.getTime() + salaryIntervalMs - 1)), 0);
  assert.equal(await processTownJobsSalaries(client, db, new Date(start.getTime() + salaryIntervalMs)), 1);
  assert.equal(db.prepare('SELECT wallet_balance FROM economy_accounts WHERE user_id = ?').get(member.id).wallet_balance, 620);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'salary'").get().count, 1);
  assert.equal(await processTownJobsSalaries(client, db, new Date(start.getTime() + salaryIntervalMs)), 0);

  const reopened = store.reopen();
  assert.equal(await processTownJobsSalaries(client, reopened, new Date(start.getTime() + salaryIntervalMs + 1)), 0);
  assert.equal(await processTownJobsSalaries(client, reopened, new Date(start.getTime() + salaryIntervalMs * 2)), 1);
  assert.equal(reopened.prepare('SELECT wallet_balance FROM economy_accounts WHERE user_id = ?').get(member.id).wallet_balance, 740);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'salary'").get().count, 2);
  const metadata = JSON.parse(reopened.prepare("SELECT metadata_json FROM economy_transactions WHERE type = 'salary' ORDER BY created_at DESC LIMIT 1").get().metadata_json);
  assert.equal(metadata.policy, 'highest');
  assert.deepEqual(metadata.roleIds, [roleA, roleB]);
});

test('combined policy pays each eligible role; losing all Town Jobs stops payments', async (t) => {
  const store = makeTempDatabase(t);
  const { db } = store;
  seedTownJob(db);
  addSalary(db, roleA, 100);
  addSalary(db, roleB, 50);
  setConfigValue(db, 'TOWN_JOBS_SALARY_POLICY', 'combined');
  const member = makeMember('combined-player', [roleA, roleB]);
  const guild = createGuild([member]);
  const client = { guilds: { cache: new Map([[config.SERVER_ID, guild]]) } };
  const start = new Date('2026-10-31T13:00:00.000Z');
  await processTownJobsSalaries(client, db, start);
  assert.equal(await processTownJobsSalaries(client, db, new Date(start.getTime() + salaryIntervalMs)), 1);
  assert.equal(db.prepare('SELECT wallet_balance FROM economy_accounts WHERE user_id = ?').get(member.id).wallet_balance, 150);
  const salary = db.prepare("SELECT metadata_json FROM economy_transactions WHERE type = 'salary'").get();
  assert.equal(JSON.parse(salary.metadata_json).policy, 'combined');

  guild.members.fetch = async () => new Map([[member.id, makeMember(member.id, [])]]);
  const stopped = await processTownJobsSalaries(client, db, new Date(start.getTime() + salaryIntervalMs * 2));
  assert.equal(stopped, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM economy_salary_schedules WHERE user_id = ?').get(member.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'salary'").get().count, 1);
});

test('management configures roles, policy, pause/resume and history; players cannot administer salaries', async (t) => {
  const store = makeTempDatabase(t);
  const { db } = store;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRoleId]));
  seedTownJob(db);

  const add = await handleSalaryCommand(commandInteraction(db, 'add', {
    getRole: () => ({ id: roleA }),
    getInteger: () => 110,
  }), { db });
  assert.match(add.content, /Enabled .*salary at 110 GV Credits/);
  const duplicate = await handleSalaryCommand(commandInteraction(db, 'add', {
    getRole: () => ({ id: roleA }),
    getInteger: () => 100,
  }), { db });
  assert.match(duplicate.content, /already has a salary entry/);

  const set = await handleSalaryCommand(commandInteraction(db, 'set', {
    getRole: () => ({ id: roleA }),
    getInteger: () => 125,
  }), { db });
  assert.match(set.content, /125 GV Credits/);
  const disabled = await handleSalaryCommand(commandInteraction(db, 'toggle', {
    getRole: () => ({ id: roleA }),
    getBoolean: () => false,
  }), { db });
  assert.match(disabled.content, /disabled/);
  assert.equal(db.prepare('SELECT enabled FROM economy_job_salaries WHERE role_id = ?').get(roleA).enabled, 0);
  const enabled = await handleSalaryCommand(commandInteraction(db, 'toggle', {
    getRole: () => ({ id: roleA }),
    getBoolean: () => true,
  }), { db });
  assert.match(enabled.content, /enabled/);
  assert.equal(db.prepare('SELECT enabled FROM economy_job_salaries WHERE role_id = ?').get(roleA).enabled, 1);
  const list = await handleSalaryCommand(commandInteraction(db, 'list'), { db });
  assert.match(list.embeds[0].data.description, /Highest salary only/);
  assert.match(list.embeds[0].data.description, /Job 1/);

  const policy = await handleSalaryCommand(commandInteraction(db, 'policy', { getString: () => 'combined' }), { db });
  assert.match(policy.content, /combined salaries/);
  const pause = await handleSalaryCommand(commandInteraction(db, 'pause'), { db });
  assert.match(pause.content, /paused/);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'TOWN_JOBS_SALARIES_ENABLED'").get().value), false);

  const pausedMember = makeMember('paused-player', [roleA]);
  const pausedGuild = createGuild([pausedMember]);
  const pausedClient = { guilds: { cache: new Map([[config.SERVER_ID, pausedGuild]]) } };
  const pausedAt = new Date('2026-10-31T14:00:00.000Z');
  db.prepare('INSERT INTO economy_accounts (user_id, created_at) VALUES (?, ?)').run(pausedMember.id, pausedAt.toISOString());
  db.prepare(`INSERT INTO economy_salary_schedules (user_id, next_due_at) VALUES (?, ?)`)
    .run(pausedMember.id, new Date(pausedAt.getTime() - 1).toISOString());
  assert.equal(await processTownJobsSalaries(pausedClient, db, pausedAt), 0);
  assert.equal(db.prepare('SELECT wallet_balance FROM economy_accounts WHERE user_id = ?').get(pausedMember.id).wallet_balance, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM economy_salary_schedules WHERE user_id = ?').get(pausedMember.id).count, 1);

  const resume = await handleSalaryCommand(commandInteraction(db, 'resume'), { db });
  assert.match(resume.content, /resumed/);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'TOWN_JOBS_SALARIES_ENABLED'").get().value), true);
  assert.ok(new Date(db.prepare('SELECT next_due_at FROM economy_salary_schedules WHERE user_id = ?').get(pausedMember.id).next_due_at).getTime() > Date.now());

  const unauthorized = commandInteraction(db, 'remove', { getRole: () => ({ id: roleA }) }, 'player');
  await handleSalaryCommand(unauthorized, { db });
  assert.match(unauthorized.lastReply.content, /management roles only/i);

  const member = makeMember('history-player', [roleA]);
  const guild = createGuild([member]);
  const client = { guilds: { cache: new Map([[config.SERVER_ID, guild]]) } };
  const start = new Date('2026-10-31T14:00:00.000Z');
  await processTownJobsSalaries(client, db, start);
  await processTownJobsSalaries(client, db, new Date(start.getTime() + salaryIntervalMs));
  const history = await handleSalaryCommand(commandInteraction(db, 'history', { getRole: () => ({ id: roleA }) }), { db });
  assert.match(history.embeds[0].data.description, /history-player/);
  assert.match(history.embeds[0].data.description, /125 GV Credits/);
  const remove = await handleSalaryCommand(commandInteraction(db, 'remove', { getRole: () => ({ id: roleA }) }), { db });
  assert.match(remove.content, /Removed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action LIKE 'economy_salary_%' OR action IN ('economy_salaries_paused', 'economy_salaries_resumed')").get().count, 8);
});