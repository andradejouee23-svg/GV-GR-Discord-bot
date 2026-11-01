const { randomUUID } = require('node:crypto');
const config = require('../../config');
const { getTownJobOptions } = require('../commands/townJobs');
const { getConfigValue } = require('../utils/discord');

const salaryIntervalMs = 30 * 60 * 1000;

function isSalaryEnabled(db) {
  return getConfigValue(db, 'TOWN_JOBS_SALARIES_ENABLED') !== false;
}

function getSalaryPolicy(db) {
  const policy = getConfigValue(db, 'TOWN_JOBS_SALARY_POLICY') ?? 'highest';
  return ['highest', 'combined'].includes(policy) ? policy : 'highest';
}

function getEligibleSalaryRoles(db) {
  const townRoleIds = new Set(getTownJobOptions(db)
    .map((job) => job?.roleId)
    .filter((roleId) => typeof roleId === 'string' && /^\d{17,20}$/.test(roleId)));
  if (!townRoleIds.size) return [];
  return db.prepare('SELECT role_id, salary FROM economy_job_salaries WHERE enabled = 1 ORDER BY role_id')
    .all().filter((salary) => townRoleIds.has(salary.role_id));
}

function calculateSalary(roles, policy) {
  if (!roles.length) return null;
  if (policy === 'highest') {
    return roles.reduce((highest, role) => {
      const currentRoleId = BigInt(role.role_id);
      const highestRoleId = BigInt(highest.role_id);
      if (role.salary > highest.salary) return role;
      if (role.salary === highest.salary && currentRoleId < highestRoleId) return role;
      return highest;
    });
  }
  const amount = roles.reduce((total, role) => total + role.salary, 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Combined Town Job salary is outside the safe integer range.');
  return { salary: amount, role_id: null };
}

function memberSalaryRoles(member, eligibleRoles) {
  return eligibleRoles.filter((role) => member.roles.cache.has(role.role_id));
}

function initializeEligibleSchedule(db, userId, nowIso, roles, policy) {
  return db.transaction(() => {
    db.prepare('INSERT INTO economy_accounts (user_id, created_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING')
      .run(userId, nowIso);
    const result = db.prepare(`
      INSERT INTO economy_salary_schedules (user_id, next_due_at, last_role_ids_json, last_policy)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).run(userId, new Date(Date.parse(nowIso) + salaryIntervalMs).toISOString(), JSON.stringify(roles.map((role) => role.role_id)), policy);
    return result.changes > 0;
  })();
}

function payDueSalary(db, userId, roles, policy, nowIso) {
  const selected = calculateSalary(roles, policy);
  const amount = selected.salary;
  const roleIds = roles.map((role) => role.role_id).sort();
  return db.transaction(() => {
    const claimed = db.prepare(`
      UPDATE economy_salary_schedules
      SET next_due_at = ?, last_paid_at = ?, last_role_ids_json = ?, last_policy = ?
      WHERE user_id = ? AND next_due_at <= ?
    `).run(
      new Date(Date.parse(nowIso) + salaryIntervalMs).toISOString(),
      nowIso,
      JSON.stringify(roleIds),
      policy,
      userId,
      nowIso,
    );
    if (!claimed.changes) return false;
    const account = db.prepare('SELECT wallet_balance, bank_balance, lifetime_earnings FROM economy_accounts WHERE user_id = ?').get(userId);
    if (!account) throw new Error(`Economy account for ${userId} was not initialized.`);
    const newWallet = account.wallet_balance + amount;
    const newLifetime = account.lifetime_earnings + amount;
    if (!Number.isSafeInteger(newWallet) || !Number.isSafeInteger(newLifetime)) {
      throw new Error(`Town Job salary would exceed the safe account balance for ${userId}.`);
    }
    db.prepare(`
      UPDATE economy_accounts SET wallet_balance = ?, lifetime_earnings = ? WHERE user_id = ?
    `).run(newWallet, newLifetime, userId);
    db.prepare(`
      INSERT INTO economy_transactions (id, user_id, type, amount, wallet_after, bank_after, created_at, metadata_json)
      VALUES (?, ?, 'salary', ?, ?, ?, ?, ?)
    `).run(randomUUID(), userId, amount, newWallet, account.bank_balance, nowIso, JSON.stringify({
      roleIds,
      policy,
      highestRoleId: selected.role_id,
      intervalMinutes: 30,
    }));
    return true;
  })();
}

async function fetchGuild(client) {
  let guild = client.guilds?.cache?.get(config.SERVER_ID);
  if (!guild) guild = await client.guilds.fetch(config.SERVER_ID);
  return guild;
}

async function processTownJobsSalaries(client, db, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Salary processing time is invalid.');
  if (!isSalaryEnabled(db)) return 0;
  const eligibleRoles = getEligibleSalaryRoles(db);
  const schedules = db.prepare('SELECT user_id FROM economy_salary_schedules').all();
  if (!eligibleRoles.length) {
    db.prepare('DELETE FROM economy_salary_schedules').run();
    return 0;
  }

  let guild;
  let members;
  try {
    guild = await fetchGuild(client);
    members = await guild.members.fetch();
  } catch (error) {
    console.error('Could not fetch Town Jobs roles for salary processing:', error.message);
    return 0;
  }

  const eligibleMembers = new Map();
  for (const member of members.values()) {
    if (member.user?.bot) continue;
    const roles = memberSalaryRoles(member, eligibleRoles);
    if (roles.length) eligibleMembers.set(member.id, roles);
  }

  for (const schedule of schedules) {
    if (!eligibleMembers.has(schedule.user_id)) {
      db.prepare('DELETE FROM economy_salary_schedules WHERE user_id = ?').run(schedule.user_id);
    }
  }

  const nowIso = nowDate.toISOString();
  const policy = getSalaryPolicy(db);
  let paidCount = 0;
  for (const [userId, roles] of eligibleMembers) {
    const schedule = db.prepare('SELECT next_due_at FROM economy_salary_schedules WHERE user_id = ?').get(userId);
    if (!schedule) {
      initializeEligibleSchedule(db, userId, nowIso, roles, policy);
      continue;
    }
    if (schedule.next_due_at > nowIso) {
      db.prepare('UPDATE economy_salary_schedules SET last_role_ids_json = ?, last_policy = ? WHERE user_id = ?')
        .run(JSON.stringify(roles.map((role) => role.role_id)), policy, userId);
      continue;
    }
    try {
      if (payDueSalary(db, userId, roles, policy, nowIso)) paidCount += 1;
    } catch (error) {
      console.error(`Town Jobs salary payment failed for ${userId}:`, error.message);
    }
  }
  return paidCount;
}

module.exports = {
  calculateSalary,
  getEligibleSalaryRoles,
  getSalaryPolicy,
  isSalaryEnabled,
  payDueSalary,
  processTownJobsSalaries,
  salaryIntervalMs,
};