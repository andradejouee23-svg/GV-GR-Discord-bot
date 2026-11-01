const config = require('../../config');
const { ensureManagement } = require('./staff');
const { getTownJobOptions } = require('./townJobs');
const { getConfigValue, makeEmbed, setConfigValue } = require('../utils/discord');
const { isSalaryEnabled, getSalaryPolicy } = require('../services/economySalaries');
const { recordEconomyAudit } = require('./economy');

function configuredJobForRole(db, roleId) {
  return getTownJobOptions(db).find((job) => job.roleId === roleId);
}

function salaryRows(db) {
  const jobs = new Map(getTownJobOptions(db).map((job) => [job.roleId, job]));
  return db.prepare('SELECT * FROM economy_job_salaries ORDER BY role_id').all().map((row) => ({
    ...row,
    job: jobs.get(row.role_id) ?? null,
  }));
}

function formatAmount(amount) {
  return `${new Intl.NumberFormat('en-US').format(amount)} ${getConfigValuePlaceholder()}`;
}

function getConfigValuePlaceholder() {
  return config.ECONOMY_CURRENCY_NAME;
}

function salaryListEmbed(db) {
  const rows = salaryRows(db);
  const enabled = isSalaryEnabled(db);
  const policy = getSalaryPolicy(db);
  const description = rows.length
    ? rows.map((row) => `**${row.job?.label ?? 'Removed Town Job'}** • <@&${row.role_id}>\n${formatAmount(row.salary)} every 30 minutes • ${row.enabled ? 'Enabled' : 'Disabled'}${row.job ? '' : ' • No longer in Town Jobs panel'}`).join('\n\n')
    : 'No Town Jobs salaries are configured. Add a role to the Town Jobs panel first, then use `/salary add`.';
  return makeEmbed(config.EMBED_COLORS.info, 'Town Jobs Salaries',
    `**System:** ${enabled ? 'Running' : 'Paused'}\n**Multiple-role policy:** ${policy === 'highest' ? 'Highest salary only' : 'Combine eligible salaries'}\n\n${description}`.slice(0, 4000));
}

async function addSalary(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const role = interaction.options.getRole('role', true);
  const amount = interaction.options.getInteger('amount', true);
  const job = configuredJobForRole(ctx.db, role.id);
  if (!job) return interaction.reply({ content: 'Add this role to the Town Jobs panel before making it salary-eligible.', ephemeral: true });
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000) {
    return interaction.reply({ content: 'Salary must be a whole number from 1 to 1,000,000,000.', ephemeral: true });
  }
  if (ctx.db.prepare('SELECT role_id FROM economy_job_salaries WHERE role_id = ?').get(role.id)) {
    return interaction.reply({ content: 'This role already has a salary entry. Use `/salary set` to change it.', ephemeral: true });
  }
  const now = new Date().toISOString();
  ctx.db.prepare(`
    INSERT INTO economy_job_salaries (role_id, salary, enabled, updated_by, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(role.id, amount, interaction.user.id, now);
  recordEconomyAudit(ctx.db, { actorId: interaction.user.id, targetId: role.id, action: 'salary_added', newValue: String(amount), now });
  return interaction.reply({ content: `Enabled **${job.label}** salary at ${formatAmount(amount)} every 30 minutes.`, ephemeral: true });
}

async function setSalary(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const role = interaction.options.getRole('role', true);
  const amount = interaction.options.getInteger('amount', true);
  const job = configuredJobForRole(ctx.db, role.id);
  if (!job) return interaction.reply({ content: 'This role is not in the current Town Jobs panel.', ephemeral: true });
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000) {
    return interaction.reply({ content: 'Salary must be a whole number from 1 to 1,000,000,000.', ephemeral: true });
  }
  const result = ctx.db.prepare('UPDATE economy_job_salaries SET salary = ?, updated_by = ?, updated_at = ? WHERE role_id = ?')
    .run(amount, interaction.user.id, new Date().toISOString(), role.id);
  if (!result.changes) return interaction.reply({ content: 'This role has no salary entry. Use `/salary add` first.', ephemeral: true });
  recordEconomyAudit(ctx.db, { actorId: interaction.user.id, targetId: role.id, action: 'salary_updated', newValue: String(amount) });
  return interaction.reply({ content: `Updated **${job.label}** salary to ${formatAmount(amount)} every 30 minutes.`, ephemeral: true });
}

async function removeSalary(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const role = interaction.options.getRole('role', true);
  const result = ctx.db.prepare('DELETE FROM economy_job_salaries WHERE role_id = ?').run(role.id);
  if (result.changes) recordEconomyAudit(ctx.db, { actorId: interaction.user.id, targetId: role.id, action: 'salary_removed' });
  return interaction.reply({ content: result.changes
    ? `Removed <@&${role.id}> from Town Jobs salary eligibility. Existing schedules are cleared on the next salary scan.`
    : 'That role has no salary entry.', ephemeral: true });
}

async function toggleSalary(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const role = interaction.options.getRole('role', true);
  const enabled = interaction.options.getBoolean('enabled', true);
  const result = ctx.db.prepare('UPDATE economy_job_salaries SET enabled = ?, updated_by = ?, updated_at = ? WHERE role_id = ?')
    .run(enabled ? 1 : 0, interaction.user.id, new Date().toISOString(), role.id);
  if (!result.changes) return interaction.reply({ content: 'That role has no salary entry. Use `/salary add` first.', ephemeral: true });
  recordEconomyAudit(ctx.db, { actorId: interaction.user.id, targetId: role.id, action: 'salary_toggled', newValue: String(enabled) });
  return interaction.reply({ content: `Salary payments for <@&${role.id}> are now **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
}

async function setSalaryPolicy(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const policy = interaction.options.getString('mode', true);
  if (!['highest', 'combined'].includes(policy)) {
    return interaction.reply({ content: 'Choose highest or combined salaries.', ephemeral: true });
  }
  setConfigValue(ctx.db, 'TOWN_JOBS_SALARY_POLICY', policy);
  recordEconomyAudit(ctx.db, { actorId: interaction.user.id, action: 'salary_policy_changed', newValue: policy });
  return interaction.reply({ content: `Multiple-role salary policy is now **${policy === 'highest' ? 'highest eligible salary' : 'combined salaries'}**.`, ephemeral: true });
}

async function pauseSalaries(interaction, ctx, enabled) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  setConfigValue(ctx.db, 'TOWN_JOBS_SALARIES_ENABLED', enabled);
  if (enabled) {
    const nextDueAt = new Date(Date.now() + 30 * 60_000).toISOString();
    ctx.db.prepare('UPDATE economy_salary_schedules SET next_due_at = ?').run(nextDueAt);
  }
  recordEconomyAudit(ctx.db, { actorId: interaction.user.id, action: enabled ? 'salaries_resumed' : 'salaries_paused', newValue: String(enabled) });
  return interaction.reply({ content: enabled
    ? 'Town Jobs salaries resumed. Existing schedules restart from now; no paused-period back pay will be issued.'
    : 'Town Jobs salary payments are paused. Wallets and existing payment history are unchanged.', ephemeral: true });
}

async function showSalaryHistory(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const role = interaction.options.getRole('role');
  const rows = ctx.db.prepare(`
    SELECT user_id, amount, created_at, metadata_json
    FROM economy_transactions WHERE type = 'salary' ORDER BY created_at DESC LIMIT 100
  `).all();
  const filtered = rows.filter((row) => !role || JSON.parse(row.metadata_json).roleIds?.includes(role.id)).slice(0, 20);
  const description = filtered.length
    ? filtered.map((row) => {
      const metadata = JSON.parse(row.metadata_json);
      const roleMentions = (metadata.roleIds ?? []).map((roleId) => `<@&${roleId}>`).join(', ') || 'Town Job';
      return `**${formatAmount(row.amount)}** • <@${row.user_id}>\n${roleMentions} • ${metadata.policy} • <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:F>`;
    }).join('\n\n')
    : 'No salary payments found for this filter.';
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, 'Recent Town Jobs Salary Payments', description.slice(0, 4000))], ephemeral: true });
}

async function handleSalaryCommand(interaction, ctx) {
  if (interaction.commandName !== 'salary') return null;
  const action = interaction.options.getSubcommand();
  if (action === 'add') return addSalary(interaction, ctx);
  if (action === 'set') return setSalary(interaction, ctx);
  if (action === 'remove') return removeSalary(interaction, ctx);
  if (action === 'toggle') return toggleSalary(interaction, ctx);
  if (action === 'list') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    return interaction.reply({ embeds: [salaryListEmbed(ctx.db)], ephemeral: true });
  }
  if (action === 'policy') return setSalaryPolicy(interaction, ctx);
  if (action === 'pause') return pauseSalaries(interaction, ctx, false);
  if (action === 'resume') return pauseSalaries(interaction, ctx, true);
  if (action === 'history') return showSalaryHistory(interaction, ctx);
  return interaction.reply({ content: 'That salary command is not available.', ephemeral: true });
}

module.exports = {
  handleSalaryCommand,
  salaryListEmbed,
};