const {
  ActionRowBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const { ensureManagement } = require('./staff');
const { getConfigValue, makeEmbed, setConfigValue } = require('../utils/discord');

const formCatalog = {
  report: {
    label: 'Player Report',
    questions: {
      player: { label: 'Player being reported', placeholder: 'Exact Discord or Roblox username.' },
      reason: { label: 'Reason for the report', placeholder: 'Example: harassment or exploiting.' },
      description: { label: 'What happened?', placeholder: 'Describe what happened and when.' },
      evidence: { label: 'Evidence link (optional)', placeholder: 'Link a screenshot, clip, or other evidence.' },
    },
  },
  blacklist_appeal: {
    label: 'Blacklist Appeal',
    questions: {
      roblox_name: { label: 'Roblox Username', placeholder: 'Enter your exact Roblox username.' },
      reconsideration: { label: 'Reason for appealing', placeholder: 'Explain why management should reconsider.' },
    },
  },
  vehicle_registration: {
    label: 'Vehicle Registration',
    questions: {
      roblox: { label: 'Roblox username', placeholder: 'Enter your exact Roblox username.' },
      vehicle: { label: 'Vehicle make and model', placeholder: 'Example: 2023 Chevrolet Tahoe.' },
      plate: { label: 'License plate', placeholder: 'Example: GV 1234.' },
      state: { label: 'Registration state / province', placeholder: 'Example: Wisconsin.' },
      color: { label: 'Vehicle color', placeholder: 'Example: Midnight blue.' },
      year: { label: 'Vehicle year (YYYY)', placeholder: 'Example: 2023.' },
    },
  },
  session: {
    label: 'RP Session',
    questions: {
      name: { label: 'Session name', placeholder: 'Example: Community Patrol.' },
      description: { label: 'Session details (optional)', placeholder: 'Optional: activity, meeting point, or schedule.' },
    },
  },
};

function getFormQuestion(db, formKey, questionKey) {
  const defaults = formCatalog[formKey]?.questions[questionKey];
  if (!defaults) throw new Error('Unknown form question.');
  const overrides = getConfigValue(db, 'FORM_QUESTION_OVERRIDES') ?? {};
  return { ...defaults, ...(overrides[formKey]?.[questionKey] ?? {}) };
}

function formsDashboardPayload(db) {
  const questions = getConfigValue(db, 'FORM_QUESTION_OVERRIDES') ?? {};
  const summary = Object.entries(formCatalog).map(([key, form]) => {
    const customized = Object.keys(questions[key] ?? {}).length;
    return `**${form.label}** • ${Object.keys(form.questions).length} questions • ${customized} customized`;
  }).join('\n');
  return {
    embeds: [makeEmbed(config.EMBED_COLORS.management, '📝 GV GR • FORMS MANAGER',
      `${summary}\n\nSelect a form to edit its question labels and placeholder instructions. Required fields and submission behavior remain unchanged.`)],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId('mgmt:forms:select')
      .setPlaceholder('Choose a form')
      .addOptions(Object.entries(formCatalog).map(([value, form]) => ({ label: form.label, value }))))],
  };
}

function formQuestionsPayload(db, formKey) {
  const form = formCatalog[formKey];
  if (!form) return null;
  const fields = Object.entries(form.questions).map(([key, defaults]) => {
    const question = getFormQuestion(db, formKey, key);
    return { name: question.label, value: `${question.placeholder || 'No placeholder'}\nKey: \`${key}\``, inline: true };
  });
  return {
    embeds: [makeEmbed(config.EMBED_COLORS.info, `📝 ${form.label} Questions`, 'Select a question to edit its label and input placeholder.').addFields(fields)],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`mgmt:forms:question:${formKey}`)
      .setPlaceholder('Choose a question')
      .addOptions(Object.entries(form.questions).map(([value, item]) => ({ label: item.label, value }))))],
  };
}

function questionModal(db, formKey, questionKey) {
  const form = formCatalog[formKey];
  const question = getFormQuestion(db, formKey, questionKey);
  return new ModalBuilder().setCustomId(`mgmt:forms:edit:${formKey}:${questionKey}`).setTitle(`Edit ${form.label} Question`)
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Question label')
        .setStyle(TextInputStyle.Short).setMaxLength(45).setRequired(true).setValue(question.label)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('placeholder').setLabel('Placeholder / example (blank clears)')
        .setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false).setValue(question.placeholder ?? '')),
    );
}

function saveQuestion(db, formKey, questionKey, label, placeholder) {
  if (!formCatalog[formKey]?.questions[questionKey]) return false;
  const current = getFormQuestion(db, formKey, questionKey);
  const overrides = getConfigValue(db, 'FORM_QUESTION_OVERRIDES') ?? {};
  overrides[formKey] ??= {};
  overrides[formKey][questionKey] = {
    label: label ?? current.label,
    placeholder: placeholder ?? current.placeholder,
  };
  setConfigValue(db, 'FORM_QUESTION_OVERRIDES', overrides);
  return true;
}

async function handleFormsCommand(interaction, ctx) {
  if (interaction.commandName !== 'forms') return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const action = interaction.options.getSubcommand();
  if (action === 'list') {
    const formKey = interaction.options.getString('form');
    if (formKey) {
      const payload = formQuestionsPayload(ctx.db, formKey);
      return payload
        ? interaction.reply({ ...payload, ephemeral: true })
        : interaction.reply({ content: 'Choose a supported form.', ephemeral: true });
    }
    return interaction.reply({ ...formsDashboardPayload(ctx.db), ephemeral: true });
  }
  const formKey = interaction.options.getString('form', true);
  const questionKey = interaction.options.getString('question', true);
  const label = interaction.options.getString('label');
  const placeholder = interaction.options.getString('placeholder');
  if (label === null && placeholder === null) return interaction.reply({ content: 'Provide a label or placeholder to update.', ephemeral: true });
  if (label !== null && (!label.trim() || label.trim().length > 45)) return interaction.reply({ content: 'Question labels must contain 1–45 characters.', ephemeral: true });
  if (!formCatalog[formKey]?.questions[questionKey]) return interaction.reply({ content: 'That question key is not part of the selected form. Use `/forms list` to view its keys.', ephemeral: true });
  saveQuestion(ctx.db, formKey, questionKey, label === null ? null : label.trim(), placeholder === null ? null : placeholder.trim());
  return interaction.reply({ content: `Saved **${formCatalog[formKey].label}** question ${questionKey}.`, ephemeral: true });
}

async function openFormsDashboard(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  return interaction.reply({ ...formsDashboardPayload(ctx.db), ephemeral: true });
}

async function handleFormsSelect(interaction, ctx) {
  if (!interaction.customId.startsWith('mgmt:forms:')) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  if (interaction.customId === 'mgmt:forms:select') {
    const payload = formQuestionsPayload(ctx.db, interaction.values[0]);
    return payload ? interaction.update(payload) : interaction.reply({ content: 'Choose a supported form.', ephemeral: true });
  }
  const match = interaction.customId.match(/^mgmt:forms:question:([a-z_]+)$/);
  if (!match || !formCatalog[match[1]]?.questions[interaction.values[0]]) {
    return interaction.reply({ content: 'Choose a question from the selected form.', ephemeral: true });
  }
  return interaction.showModal(questionModal(ctx.db, match[1], interaction.values[0]));
}

async function handleFormsModal(interaction, ctx) {
  const match = interaction.customId.match(/^mgmt:forms:edit:([a-z_]+):([a-z_]+)$/);
  if (!match) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  if (!formCatalog[match[1]]?.questions[match[2]]) return interaction.reply({ content: 'This form question is not available.', ephemeral: true });
  const label = interaction.fields.getTextInputValue('label').trim();
  const placeholder = interaction.fields.getTextInputValue('placeholder').trim();
  if (!label || label.length > 45) return interaction.reply({ content: 'Question labels must contain 1–45 characters.', ephemeral: true });
  saveQuestion(ctx.db, match[1], match[2], label, placeholder);
  return interaction.reply({ content: `Saved **${formCatalog[match[1]].label}** question. Required status and processing remain unchanged.`, ephemeral: true });
}

module.exports = {
  formCatalog,
  getFormQuestion,
  handleFormsModal,
  handleFormsCommand,
  handleFormsSelect,
  openFormsDashboard,
};