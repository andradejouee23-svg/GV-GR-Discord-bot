const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const { ensureManagement } = require('./staff');
const { applyPanelCustomization, ensurePanelHeader } = require('./panelEditor');
const {
  fetchGuildMember,
  getConfigValue,
  makeEmbed,
  setConfigValue,
  validId,
} = require('../utils/discord');

const applicationDraftLifetimeMs = 15 * 60 * 1000;
const applicationQuestionsPerPage = 4;
const activeApplicationStatuses = ['pending', 'approving', 'approved', 'expiring'];

function normalizeQuestion(question, index = 0) {
  if (typeof question === 'string') return { label: question, type: 'paragraph', required: true, options: [], position: index };
  const type = ['short', 'paragraph', 'multiple_choice', 'dropdown', 'yes_no'].includes(question?.type) ? question.type : 'paragraph';
  const options = type === 'yes_no' ? ['Yes', 'No'] : Array.isArray(question?.options) ? question.options.map((value) => String(value).trim()).filter(Boolean).slice(0, 25) : [];
  return { label: String(question?.label ?? '').trim(), type, required: question?.required !== false, options, position: index };
}

function questionLabel(question, index) {
  return normalizeQuestion(question, index).label;
}

function validateQuestionAnswer(question, answer) {
  const normalized = normalizeQuestion(question);
  const trimmed = answer.trim();
  if (normalized.required && !trimmed) return 'This question requires an answer.';
  if (!trimmed) return null;
  if (['multiple_choice', 'dropdown', 'yes_no'].includes(normalized.type)) {
    const selected = normalized.type === 'multiple_choice' ? trimmed.split(',').map((value) => value.trim()) : [trimmed];
    if (selected.some((choice) => !normalized.options.some((option) => option.toLowerCase() === choice.toLowerCase()))) {
      return `Choose from: ${normalized.options.join(', ')}.`;
    }
  }
  return null;
}

function getApplicationSettings(db) {
  const configuredQuestions = getConfigValue(db, 'TEMP_ADMIN_APPLICATION_QUESTIONS');
  const questions = (Array.isArray(configuredQuestions) ? configuredQuestions : config.TEMP_ADMIN_APPLICATION_QUESTIONS)
    .filter((question) => !/\b(?:Discord|Roblox) user ID\b/i.test(typeof question === 'string' ? question : question?.label ?? ''))
    .map((question) => {
      const label = typeof question === 'string' ? question : question?.label ?? '';
      if (!/Discord username/i.test(label)) return question;
      return typeof question === 'string'
        ? { label, type: 'short', required: false }
        : { ...question, type: 'short', required: false };
    });
  return {
    title: getConfigValue(db, 'TEMP_ADMIN_APPLICATION_TITLE') ?? config.TEMP_ADMIN_APPLICATION_TITLE,
    description: getConfigValue(db, 'TEMP_ADMIN_APPLICATION_DESCRIPTION') ?? config.TEMP_ADMIN_APPLICATION_DESCRIPTION,
    questions,
    durationHours: Number(getConfigValue(db, 'TEMP_ADMIN_DURATION_HOURS') ?? config.TEMP_ADMIN_DURATION_HOURS),
    trialReminderHours: Number(getConfigValue(db, 'TEMP_ADMIN_TRIAL_REMINDER_HOURS') ?? config.TEMP_ADMIN_TRIAL_REMINDER_HOURS ?? 12),
    enabled: getConfigValue(db, 'TEMP_ADMIN_APPLICATIONS_ENABLED') !== false,
    roleId: getConfigValue(db, 'TEMP_ADMIN_ROLE_ID'),
    reviewChannelId: getConfigValue(db, 'TEMP_ADMIN_REVIEW_CHANNEL_ID'),
  };
}

function isApplicationConfigured(settings) {
  return validId(settings.roleId)
    && validId(settings.reviewChannelId)
    && Number.isInteger(settings.durationHours)
    && settings.durationHours >= 1
    && settings.durationHours <= 8760
    && Array.isArray(settings.questions)
    && settings.questions.length >= 1
    && settings.questions.length <= 20;
}

function createApplicationModal(draftId, settings, page = 0, answers = []) {
  const questions = settings.questions.map((question, index) => normalizeQuestion(question, index));
  const pageCount = Math.ceil(questions.length / applicationQuestionsPerPage);
  const pageQuestions = questions.slice(page * applicationQuestionsPerPage, (page + 1) * applicationQuestionsPerPage);
  const modal = new ModalBuilder()
    .setCustomId(pageCount > 1 ? `gv:tempadmin:apply:${draftId}:${page}` : `gv:tempadmin:apply:${draftId}`)
    .setTitle(`${settings.title.slice(0, pageCount > 1 ? 32 : 45)}${pageCount > 1 ? ` • ${page + 1}/${pageCount}` : ''}`);
  pageQuestions.filter((question) => !['multiple_choice', 'dropdown', 'yes_no'].includes(question.type)).forEach((question) => {
    const globalIndex = question.position;
    const input = new TextInputBuilder()
      .setCustomId(`answer_${globalIndex}`)
      .setLabel(question.label.slice(0, 45))
      .setStyle(question.type === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
      .setMaxLength(1000)
      .setRequired(question.required)
      .setPlaceholder(/Roblox username/i.test(question.label)
        ? 'Enter your exact Roblox username.'
        : /Discord username/i.test(question.label)
          ? 'Enter your Discord username or display name.'
          : /how old|age/i.test(question.label)
            ? 'Enter your age in years.'
            : question.type === 'short' ? 'Provide a clear, direct answer.' : 'Include relevant details; do not share passwords.');
    if (answers[globalIndex]) input.setValue(String(answers[globalIndex]).slice(0, 1000));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });
  return modal;
}

function pageQuestionSet(settings, page) {
  const questions = settings.questions.map((question, index) => normalizeQuestion(question, index));
  return questions.slice(page * applicationQuestionsPerPage, (page + 1) * applicationQuestionsPerPage);
}

function hasTextQuestions(settings, page) {
  return pageQuestionSet(settings, page).some((question) => !['multiple_choice', 'dropdown', 'yes_no'].includes(question.type));
}

function choicePagePayload(draftId, draft, page) {
  const questions = pageQuestionSet(draft.settings, page).filter((question) => ['multiple_choice', 'dropdown', 'yes_no'].includes(question.type));
  const rows = questions.map((question) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`gv:tempadmin:choice:${draftId}:${page}:${question.position}`)
      .setPlaceholder(question.label.slice(0, 150))
      .setMinValues(question.required ? 1 : 0)
      .setMaxValues(question.type === 'multiple_choice' ? question.options.length : 1)
      .addOptions(question.options.map((label) => ({ label: label.slice(0, 100), value: label })));
    return new ActionRowBuilder().addComponents(menu);
  });
  const pageCount = Math.ceil(draft.settings.questions.length / applicationQuestionsPerPage);
  const navigation = [];
  if (page > 0) navigation.push(new ButtonBuilder().setCustomId(`gv:tempadmin:continue:${draftId}:${page - 1}`).setLabel('Back').setStyle(ButtonStyle.Secondary));
  if (page < pageCount - 1) navigation.push(new ButtonBuilder().setCustomId(`gv:tempadmin:continue:${draftId}:${page + 1}`).setLabel('Continue').setStyle(ButtonStyle.Primary));
  else navigation.push(new ButtonBuilder().setCustomId(`gv:tempadmin:submit:${draftId}:${page}`).setLabel('Submit Application').setStyle(ButtonStyle.Success));
  navigation.push(new ButtonBuilder().setCustomId(`gv:tempadmin:cancel:${draftId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger));
  if (navigation.length) rows.push(new ActionRowBuilder().addComponents(navigation));
  return {
    content: `**${draft.settings.title}** • Select your answers for page ${page + 1} of ${pageCount}. Your choices save as you go.`,
    components: rows,
    ephemeral: true,
  };
}

function applicationPanelEmbed(settings) {
  const embed = makeEmbed(config.EMBED_COLORS.management, settings.title, settings.description)
    .addFields(
      { name: 'Application questions', value: settings.questions.map((question, index) => `**${index + 1}.** ${questionLabel(question, index)}`).join('\n').slice(0, 1024) },
      { name: 'Temporary role duration', value: `${settings.durationHours} hour${settings.durationHours === 1 ? '' : 's'}`, inline: true },
    )
    .setFooter({ text: 'GV GR • Temporary Administration' });
  return embed;
}

function applicationPanelComponents() {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId('gv:tempadmin:apply')
    .setLabel('Apply for Temporary Admin')
    .setEmoji('📝')
    .setStyle(ButtonStyle.Primary))];
}

function applicationCode(id) {
  return `TA-${String(id).padStart(6, '0')}`;
}

function addApplicationHistory(db, applicationId, actorId, action, details, createdAt) {
  db.prepare(`
    INSERT INTO temporary_admin_application_history (application_id, actor_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(applicationId, actorId, action, JSON.stringify(details ?? {}), createdAt);
}

function createApplicationDraft(db, applicantId, settings, now = Date.now()) {
  const id = randomUUID().replaceAll('-', '');
  const createdAt = new Date(now).toISOString();
  db.prepare('DELETE FROM temporary_admin_application_drafts WHERE expires_at <= ?').run(createdAt);
  db.prepare(`
    INSERT INTO temporary_admin_application_drafts (id, applicant_id, settings_json, answers_json, current_page, created_at, expires_at)
    VALUES (?, ?, ?, '[]', 0, ?, ?)
  `).run(id, applicantId, JSON.stringify(settings), createdAt, new Date(now + applicationDraftLifetimeMs).toISOString());
  return id;
}

function getApplicationDraft(db, draftId, applicantId, now = new Date()) {
  if (!/^[a-f0-9]{32}$/.test(draftId ?? '')) return null;
  const row = db.prepare('SELECT * FROM temporary_admin_application_drafts WHERE id = ? AND applicant_id = ?')
    .get(draftId, applicantId);
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) {
    db.prepare('DELETE FROM temporary_admin_application_drafts WHERE id = ?').run(draftId);
    return null;
  }
  return { ...row, settings: JSON.parse(row.settings_json), answers: JSON.parse(row.answers_json ?? '[]') };
}

function saveApplicationDraftProgress(db, draftId, applicantId, answers, currentPage) {
  return db.prepare('UPDATE temporary_admin_application_drafts SET answers_json = ?, current_page = ? WHERE id = ? AND applicant_id = ?')
    .run(JSON.stringify(answers), currentPage, draftId, applicantId).changes > 0;
}

async function openApplicationPanel(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const settings = getApplicationSettings(ctx.db);
  if (!isApplicationConfigured(settings)) {
    return interaction.reply({ content: 'Configure the temporary admin role, review channel, duration, and at least one question before publishing the panel.', ephemeral: true });
  }
  const channel = interaction.options.getChannel('channel', true);
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: 'I need View Channel, Send Messages, and Embed Links permissions in the application channel.', ephemeral: true });
  }

  const customized = applyPanelCustomization(ctx.db, 'tempadmin', applicationPanelEmbed(settings), applicationPanelComponents());
  const payload = { embeds: [customized.embed], components: customized.components };
  let message;
  const savedChannelId = getConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_CHANNEL_ID');
  let savedMessageId = getConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_MESSAGE_ID');
  const header = await ensurePanelHeader(interaction.client, ctx.db, 'tempadmin', channel);
  if (header.created && savedChannelId === channel.id && savedMessageId) {
    try { const previous = await channel.messages.fetch(savedMessageId); if (previous.author?.id === interaction.client.user?.id) await previous.delete(); } catch {}
    setConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_MESSAGE_ID', null);
    savedMessageId = null;
  }
  if (savedChannelId === channel.id && validId(savedMessageId)) {
    try {
      const previous = await channel.messages.fetch(savedMessageId);
      message = await previous.edit(payload);
    } catch {
      message = null;
    }
  }
  const refreshed = Boolean(message);
  if (!message) message = await channel.send(payload);
  setConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_CHANNEL_ID', channel.id);
  setConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_MESSAGE_ID', message.id);
  return interaction.reply({ content: `Temporary Admin application panel ${refreshed ? 'refreshed' : 'posted'} in <#${channel.id}>.`, ephemeral: true });
}

async function configureApplications(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const options = interaction.options;
  const changes = [];
  const title = options.getString('title');
  const description = options.getString('description');
  const role = options.getRole('role');
  const reviewChannel = options.getChannel('review-channel');
  const durationHours = options.getInteger('duration-hours');
  const reminderHours = options.getInteger('reminder-hours');
  const enabled = options.getBoolean?.('enabled');
  const questionValues = [1, 2, 3, 4, 5].map((number) => options.getString(`question-${number}`));

  if (title !== null) {
    if (!title.trim()) return interaction.reply({ content: 'Application title cannot be empty.', ephemeral: true });
    changes.push(['TEMP_ADMIN_APPLICATION_TITLE', title.trim()]);
  }
  if (description !== null) {
    if (!description.trim()) return interaction.reply({ content: 'Application description cannot be empty.', ephemeral: true });
    changes.push(['TEMP_ADMIN_APPLICATION_DESCRIPTION', description.trim()]);
  }
  if (role) changes.push(['TEMP_ADMIN_ROLE_ID', role.id]);
  if (reviewChannel) changes.push(['TEMP_ADMIN_REVIEW_CHANNEL_ID', reviewChannel.id]);
  if (durationHours !== null) changes.push(['TEMP_ADMIN_DURATION_HOURS', durationHours]);
  if (reminderHours !== null) changes.push(['TEMP_ADMIN_TRIAL_REMINDER_HOURS', reminderHours]);
  if (typeof enabled === 'boolean') changes.push(['TEMP_ADMIN_APPLICATIONS_ENABLED', enabled]);
  if (questionValues.some((question) => question !== null)) {
    const questions = questionValues.filter((question) => question !== null).map((question) => question.trim());
    if (questions.some((question) => !question || question.length > 45)) {
      return interaction.reply({ content: 'Application questions must contain 1–45 characters.', ephemeral: true });
    }
    changes.push(['TEMP_ADMIN_APPLICATION_QUESTIONS', questions]);
  }
  if (!changes.length) return interaction.reply({ content: 'Choose at least one application setting to update.', ephemeral: true });

  ctx.db.transaction(() => {
    for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
  })();
  return interaction.reply({ content: `Updated temporary admin settings: ${changes.map(([key]) => `**${key}**`).join(', ')}.`, ephemeral: true });
}

function parseQuestionOptions(type, text) {
  if (type === 'yes_no') return ['Yes', 'No'];
  if (!['multiple_choice', 'dropdown'].includes(type)) return [];
  const options = String(text ?? '').split('\n').map((value) => value.trim()).filter(Boolean);
  if (options.length < 2 || options.length > 25 || options.some((value) => value.length > 100)) throw new Error('Choice questions need 2–25 options, one per line, with each option at most 100 characters.');
  return options;
}

function questionListEmbed(questions) {
  const lines = questions.map((raw, index) => {
    const question = normalizeQuestion(raw, index);
    const options = question.options.length ? ` • ${question.options.join(', ')}` : '';
    return `**${index + 1}. ${question.label}**\nType: ${question.type.replaceAll('_', ' ')} • ${question.required ? 'Required' : 'Optional'}${options}`;
  });
  return makeEmbed(config.EMBED_COLORS.management, 'Temporary Admin Form Builder', lines.join('\n\n').slice(0, 3900) || 'No questions are configured.');
}

async function manageQuestions(interaction, ctx, action) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const questions = getApplicationSettings(ctx.db).questions.map((question, index) => normalizeQuestion(question, index));
  const options = interaction.options;
  if (action === 'question-list') return interaction.reply({ embeds: [questionListEmbed(questions)], ephemeral: true });
  if (action === 'question-add') {
    if (questions.length >= 20) return interaction.reply({ content: 'Temporary Admin forms support up to 20 questions.', ephemeral: true });
    const label = options.getString('label', true).trim();
    const type = options.getString('type', true);
    const required = options.getBoolean('required', true);
    let choices;
    try { choices = parseQuestionOptions(type, options.getString('options')); } catch (error) { return interaction.reply({ content: error.message, ephemeral: true }); }
    if (!label || label.length > 45) return interaction.reply({ content: 'Question labels must contain 1–45 characters.', ephemeral: true });
    questions.push({ label, type, required, options: choices });
  } else if (action === 'question-edit') {
    const index = options.getInteger('index', true) - 1;
    if (!questions[index]) return interaction.reply({ content: 'Question number not found. Use `/tempadmin question-list`.', ephemeral: true });
    const label = options.getString('label');
    const type = options.getString('type');
    const required = options.getBoolean('required');
    const rawOptions = options.getString('options');
    if (label !== null) questions[index].label = label.trim();
    if (type !== null) {
      questions[index].type = type;
      questions[index].options = parseQuestionOptions(type, rawOptions ?? '');
    } else if (rawOptions !== null) {
      questions[index].options = parseQuestionOptions(questions[index].type, rawOptions);
    }
    if (typeof required === 'boolean') questions[index].required = required;
    if (!questions[index].label || questions[index].label.length > 45) return interaction.reply({ content: 'Question labels must contain 1–45 characters.', ephemeral: true });
  } else if (action === 'question-remove') {
    const index = options.getInteger('index', true) - 1;
    if (!questions[index]) return interaction.reply({ content: 'Question number not found.', ephemeral: true });
    questions.splice(index, 1);
    if (!questions.length) return interaction.reply({ content: 'A form must keep at least one question.', ephemeral: true });
  } else if (action === 'question-move') {
    const from = options.getInteger('from', true) - 1;
    const to = options.getInteger('to', true) - 1;
    if (!questions[from] || to < 0 || to >= questions.length) return interaction.reply({ content: 'Question positions must refer to configured questions.', ephemeral: true });
    questions.splice(to, 0, questions.splice(from, 1)[0]);
  }
  setConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_QUESTIONS', questions.map(({ label, type, required, options: choices }, position) => ({ label, type, required, options: choices, position })));
  return interaction.reply({ embeds: [questionListEmbed(questions)], content: 'Temporary Admin form saved. Existing submitted applications keep their question snapshots.', ephemeral: true });
}

async function startApplication(interaction, ctx) {
  if (interaction.user.bot) return interaction.reply({ content: 'Bot accounts cannot submit applications.', ephemeral: true });
  const settings = getApplicationSettings(ctx.db);
  if (!settings.enabled) return interaction.reply({ content: 'Temporary Admin applications are temporarily closed.', ephemeral: true });
  if (!isApplicationConfigured(settings)) {
    return interaction.reply({ content: 'Temporary Admin applications are not configured yet. Please contact management.', ephemeral: true });
  }
  const open = ctx.db.prepare(`
    SELECT id, status FROM temporary_admin_applications
    WHERE applicant_id = ? AND status IN ('pending', 'approving', 'approved', 'expiring') LIMIT 1
  `).get(interaction.user.id);
  if (open) return interaction.reply({ content: open.status === 'approved'
    ? `You already have an active Temporary Admin application (${applicationCode(open.id)}).`
    : `You already have a Temporary Admin application under review (${applicationCode(open.id)}).`, ephemeral: true });

  const draftId = createApplicationDraft(ctx.db, interaction.user.id, settings);
  const draft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  return hasTextQuestions(settings, 0)
    ? interaction.showModal(createApplicationModal(draftId, settings, 0, []))
    : interaction.reply(choicePagePayload(draftId, draft, 0));
}

function applicationPageControls(draftId, page, pageCount) {
  const buttons = [];
  if (page > 0) buttons.push(new ButtonBuilder().setCustomId(`gv:tempadmin:continue:${draftId}:${page - 1}`).setLabel('Back').setStyle(ButtonStyle.Secondary));
  if (page < pageCount - 1) buttons.push(new ButtonBuilder().setCustomId(`gv:tempadmin:continue:${draftId}:${page + 1}`).setLabel('Continue').setStyle(ButtonStyle.Primary));
  else buttons.push(new ButtonBuilder().setCustomId(`gv:tempadmin:submit:${draftId}:${page}`).setLabel('Submit Application').setStyle(ButtonStyle.Success));
  buttons.push(new ButtonBuilder().setCustomId(`gv:tempadmin:cancel:${draftId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger));
  return [new ActionRowBuilder().addComponents(buttons)];
}

async function submitApplication(interaction, ctx, draftId, page = 0) {
  const draft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This application form expired. Reopen the panel to start again.', ephemeral: true });
  const settings = draft.settings;
  const questions = settings.questions.map((question, index) => normalizeQuestion(question, index));
  const pageCount = Math.ceil(questions.length / applicationQuestionsPerPage);
  if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) return interaction.reply({ content: 'This application page is invalid. Reopen the panel.', ephemeral: true });
  const answers = draft.answers.slice();
  const pageQuestions = questions.slice(page * applicationQuestionsPerPage, (page + 1) * applicationQuestionsPerPage);
  for (const question of pageQuestions.filter((item) => !['multiple_choice', 'dropdown', 'yes_no'].includes(item.type))) {
    const answer = interaction.fields.getTextInputValue(`answer_${question.position}`).trim();
    const invalid = validateQuestionAnswer(question, answer);
    if (invalid) return interaction.reply({ content: `${question.label}: ${invalid}`, ephemeral: true });
    answers[question.position] = answer;
  }
  saveApplicationDraftProgress(ctx.db, draftId, interaction.user.id, answers, page);
  const updatedDraft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  if (pageQuestions.some((question) => ['multiple_choice', 'dropdown', 'yes_no'].includes(question.type))) {
    return interaction.reply(choicePagePayload(draftId, updatedDraft, page));
  }
  const content = page < pageCount - 1
    ? `Saved page ${page + 1} of ${pageCount}. Continue, go back, or cancel.`
    : 'All answers are saved. Review or change an earlier page, submit the application, or cancel.';
  return interaction.reply({ content, components: applicationPageControls(draftId, page, pageCount), ephemeral: true });
}

async function handleTempAdminSelect(interaction, ctx) {
  const match = interaction.customId.match(/^gv:tempadmin:choice:([a-f0-9]{32}):(\d+):(\d+)$/);
  if (!match) return null;
  const [, draftId, pageText, questionText] = match;
  const draft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This application form expired. Reopen the panel to start again.', ephemeral: true });
  const page = Number(pageText);
  const questionIndex = Number(questionText);
  const question = draft.settings.questions.map((raw, index) => normalizeQuestion(raw, index))[questionIndex];
  if (!question || Math.floor(questionIndex / applicationQuestionsPerPage) !== page || !['multiple_choice', 'dropdown', 'yes_no'].includes(question.type)) return interaction.reply({ content: 'This form selection is invalid.', ephemeral: true });
  const answer = (interaction.values ?? []).join(', ');
  const invalid = validateQuestionAnswer(question, answer);
  if (invalid) return interaction.reply({ content: `${question.label}: ${invalid}`, ephemeral: true });
  const answers = draft.answers.slice();
  answers[questionIndex] = answer;
  saveApplicationDraftProgress(ctx.db, draftId, interaction.user.id, answers, page);
  return interaction.update(choicePagePayload(draftId, getApplicationDraft(ctx.db, draftId, interaction.user.id), page));
}

async function continueApplicationPage(interaction, ctx, draftId, page) {
  const draft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This application form expired. Reopen the panel to start again.', ephemeral: true });
  const pageCount = Math.ceil(draft.settings.questions.length / applicationQuestionsPerPage);
  if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) return interaction.reply({ content: 'This application page is invalid.', ephemeral: true });
  if (hasTextQuestions(draft.settings, page)) return interaction.showModal(createApplicationModal(draftId, draft.settings, page, draft.answers));
  return interaction.reply(choicePagePayload(draftId, draft, page));
}

async function submitChoiceApplication(interaction, ctx, draftId, page) {
  const draft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This application form expired. Reopen the panel to start again.', ephemeral: true });
  const questions = draft.settings.questions.map((question, index) => normalizeQuestion(question, index));
  const pageCount = Math.ceil(questions.length / applicationQuestionsPerPage);
  if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) return interaction.reply({ content: 'This application page is invalid.', ephemeral: true });
  const pageQuestions = questions.slice(page * applicationQuestionsPerPage, (page + 1) * applicationQuestionsPerPage);
  const missing = pageQuestions.find((question) => validateQuestionAnswer(question, draft.answers[question.position] ?? '') !== null);
  if (missing) return interaction.reply({ content: `Select an answer for “${missing.label}” before continuing.`, ephemeral: true });
  if (page < pageCount - 1) return continueApplicationPage(interaction, ctx, draftId, page + 1);
  return finishApplicationSubmission(interaction, ctx, draftId, draft, draft.answers);
}

async function cancelApplicationDraft(interaction, ctx, draftId) {
  const result = ctx.db.prepare('DELETE FROM temporary_admin_application_drafts WHERE id = ? AND applicant_id = ?')
    .run(draftId, interaction.user.id);
  if (!result.changes) return interaction.reply({ content: 'This application draft is no longer available.', ephemeral: true });
  return interaction.update({ content: 'Temporary Admin application cancelled. Saved draft answers were removed.', embeds: [], components: [] });
}

async function getReviewChannel(interaction, reviewChannelId) {
  let channel;
  try {
    channel = await interaction.client.channels.fetch(reviewChannelId);
  } catch (error) {
    console.error('Could not fetch Temporary Admin review channel:', error.message);
  }
  if (!channel || channel.guildId !== interaction.guild.id || !channel.isTextBased() || !channel.send) {
    return { error: 'The Temporary Admin review channel is unavailable. Please contact management.' };
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return { error: 'The bot needs View Channel, Send Messages, and Embed Links permissions in the review channel.' };
  }
  return { channel };
}

function applicationReviewEmbed(application) {
  const embed = makeEmbed(config.EMBED_COLORS.warning,
    `${application.application_title.slice(0, 235)} • ${applicationCode(application.id)}`,
    `**Applicant:** <@${application.applicant_id}>\n**Username:** ${application.applicant_name}\n**Submitted:** <t:${Math.floor(new Date(application.created_at).getTime() / 1000)}:F>\n**Requested role:** <@&${application.requested_role_id}>\n**Trial:** ${application.trial_duration_hours ?? application.duration_hours} hours\n**Review state:** ${(application.review_state ?? 'pending').replaceAll('_', ' ')}`)
    .setFooter({ text: 'GV GR • Temporary Admin Application • Management review only' });
  const questions = JSON.parse(application.questions_json).map((question, index) => normalizeQuestion(question, index));
  const answers = JSON.parse(application.answers_json);
  embed.addFields(questions.map((question, index) => ({
    name: question.label,
    value: answers[index] || 'No answer provided.',
  })));
  if (application.management_notes) embed.addFields({ name: 'Private Management Notes', value: application.management_notes.slice(0, 1000) });
  return embed;
}

function applicationReviewComponents(applicationId, reviewState = 'pending') {
  if (reviewState === 'on_hold') return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:tempadmin:resume:${applicationId}`).setLabel('Resume Review').setEmoji('▶️').setStyle(ButtonStyle.Primary),
  )];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:tempadmin:approve:${applicationId}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gv:tempadmin:deny:${applicationId}`).setLabel('Deny').setEmoji('⛔').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`gv:tempadmin:info:${applicationId}`).setLabel('Request Info').setEmoji('❓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gv:tempadmin:hold:${applicationId}`).setLabel('Put On Hold').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
  )];
}

function decisionEmbed(application, approved) {
  const isApproved = approved;
  const fields = [
    `**Application:** ${applicationCode(application.id)}`,
    `**Role:** <@&${application.requested_role_id}>`,
    `**Submitted:** <t:${Math.floor(new Date(application.created_at).getTime() / 1000)}:F>`,
    `**Reviewed by:** <@${application.reviewer_id}>`,
    `**Status:** ${isApproved ? 'Trial Started' : 'Denied'}`,
    isApproved ? `**Trial started:** <t:${Math.floor(new Date(application.trial_started_at ?? application.reviewed_at).getTime() / 1000)}:F>` : null,
    isApproved ? `**Trial ends:** <t:${Math.floor(new Date(application.expires_at).getTime() / 1000)}:F>` : null,
    isApproved ? `**Trial extensions:** ${application.trial_extensions ?? 0}` : null,
    !isApproved && application.decision_reason ? `**Reason:** ${application.decision_reason}` : null,
  ].filter(Boolean).join('\n');
  return makeEmbed(isApproved ? config.EMBED_COLORS.active : config.EMBED_COLORS.error,
    isApproved ? '✅ Temporary Admin Application Approved' : '⛔ Temporary Admin Application Denied', fields)
    .setFooter({ text: `GV GR • ${applicationCode(application.id)}` })
    .setTimestamp(new Date(application.reviewed_at));
}

async function notifyApplicant(client, application, embed) {
  try {
    const user = await client.users.fetch(application.applicant_id);
    await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    console.error(`Could not DM Temporary Admin applicant ${application.applicant_id}:`, error.message);
    return false;
  }
}

async function updateReviewMessage(client, application, embed) {
  if (!application.review_channel_id || !application.review_message_id) return false;
  try {
    const channel = await client.channels.fetch(application.review_channel_id);
    const message = channel?.isTextBased() ? await channel.messages.fetch(application.review_message_id) : null;
    if (!message) return false;
    const components = ['pending', 'info_requested', 'on_hold'].includes(application.review_state ?? 'pending')
      ? applicationReviewComponents(application.id, application.review_state ?? 'pending') : [];
    await message.edit({ embeds: [embed], components });
    return true;
  } catch (error) {
    console.error(`Could not update Temporary Admin application ${applicationCode(application.id)}:`, error.message);
    return false;
  }
}

async function finishApplicationSubmission(interaction, ctx, draftId, draft, answers) {
  const settings = draft.settings;
  if (!isApplicationConfigured(settings)) return interaction.reply({ content: 'This application form is no longer configured. Contact management.', ephemeral: true });
  if (answers.length !== settings.questions.length || answers.some((answer, index) => validateQuestionAnswer(settings.questions[index], answer) !== null)) {
    return interaction.reply({ content: 'One or more answers are missing or invalid. Review the saved application pages and try again.', ephemeral: true });
  }
  const review = await getReviewChannel(interaction, settings.reviewChannelId);
  if (review.error) return interaction.reply({ content: review.error, ephemeral: true });

  let applicationId;
  const createdAt = new Date().toISOString();
  try {
    applicationId = ctx.db.transaction(() => {
      const open = ctx.db.prepare(`
        SELECT id FROM temporary_admin_applications
        WHERE applicant_id = ? AND status IN ('pending', 'approving', 'approved', 'expiring') LIMIT 1
      `).get(interaction.user.id);
      if (open) throw new Error('You already have a pending or active Temporary Admin application.');
      const result = ctx.db.prepare(`
        INSERT INTO temporary_admin_applications (
          applicant_id, applicant_name, application_title, application_description,
          questions_json, answers_json, requested_role_id, duration_hours, status,
          created_at, review_channel_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(interaction.user.id, interaction.user.username, settings.title, settings.description,
        JSON.stringify(settings.questions), JSON.stringify(answers), settings.roleId, settings.durationHours,
        createdAt, review.channel.id);
      const id = Number(result.lastInsertRowid);
      addApplicationHistory(ctx.db, id, interaction.user.id, 'submitted', { answers }, createdAt);
      ctx.db.prepare('DELETE FROM temporary_admin_application_drafts WHERE id = ?').run(draftId);
      return id;
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return interaction.reply({ content: 'You already have a pending or active Temporary Admin application.', ephemeral: true });
    }
    return interaction.reply({ content: error.message, ephemeral: true });
  }

  const application = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  let message;
  try {
    message = await review.channel.send({
      embeds: [applicationReviewEmbed(application)],
      components: applicationReviewComponents(applicationId, application.review_state),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error(`Could not post Temporary Admin application ${applicationCode(applicationId)}:`, error.message);
  }
  if (message) {
    ctx.db.prepare('UPDATE temporary_admin_applications SET review_message_id = ? WHERE id = ?')
      .run(message.id, applicationId);
  }
  await notifyApplicant(interaction.client, ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId),
    makeEmbed(config.EMBED_COLORS.info, 'Temporary Admin Application Received', `Your application ${applicationCode(applicationId)} was received and sent to management for review.`));
  return interaction.reply({ content: message
    ? `Application ${applicationCode(applicationId)} was sent to management for review.`
    : `Application ${applicationCode(applicationId)} was saved, but staff could not be notified. You can check its status with /tempadmin history.`, ephemeral: true });
}

function denialModal(applicationId) {
  const input = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Optional reason for denial')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(false)
    .setPlaceholder('Optional: explain what should be reconsidered.');
  return new ModalBuilder()
    .setCustomId(`gv:tempadmin:deny_submit:${applicationId}`)
    .setTitle('Deny Temporary Admin Application')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function moreInformationModal(applicationId) {
  return new ModalBuilder().setCustomId(`gv:tempadmin:info_submit:${applicationId}`).setTitle('Request More Information')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('request').setLabel('What information should they provide?')
      .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)
      .setPlaceholder('List the specific details or evidence needed.')));
}

async function setReviewState(interaction, ctx, applicationId, reviewState) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'pending'").get(applicationId);
  if (!application) return interaction.reply({ content: 'This application is no longer awaiting review.', ephemeral: true });
  const now = new Date().toISOString();
  const changed = ctx.db.transaction(() => {
    const result = ctx.db.prepare("UPDATE temporary_admin_applications SET review_state = ?, reviewer_id = ? WHERE id = ? AND status = 'pending'")
      .run(reviewState, interaction.user.id, applicationId);
    if (!result.changes) return false;
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, reviewState, {}, now);
    return true;
  })();
  if (!changed) return interaction.reply({ content: 'This application changed while you were reviewing it.', ephemeral: true });
  const updated = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  await updateReviewMessage(interaction.client, updated, applicationReviewEmbed(updated));
  if (reviewState === 'on_hold') {
    await notifyApplicant(interaction.client, updated, makeEmbed(config.EMBED_COLORS.warning, 'Temporary Admin Application On Hold', `Your application ${applicationCode(applicationId)} has been placed on hold while management reviews it.`));
  }
  return interaction.reply({ content: `Application ${applicationCode(applicationId)} is now ${reviewState.replaceAll('_', ' ')}.`, ephemeral: true });
}

async function submitMoreInformationRequest(interaction, ctx, applicationId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const message = interaction.fields.getTextInputValue('request').trim();
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'pending'").get(applicationId);
  if (!application) return interaction.reply({ content: 'This application is no longer awaiting review.', ephemeral: true });
  const now = new Date().toISOString();
  const changed = ctx.db.transaction(() => {
    const result = ctx.db.prepare("UPDATE temporary_admin_applications SET review_state = 'info_requested', reviewer_id = ?, decision_reason = ? WHERE id = ? AND status = 'pending' AND review_state != 'on_hold'")
      .run(interaction.user.id, message, applicationId);
    if (!result.changes) return false;
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'info_requested', { message }, now);
    return true;
  })();
  if (!changed) return interaction.reply({ content: 'This application was already updated.', ephemeral: true });
  const updated = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  await updateReviewMessage(interaction.client, updated, applicationReviewEmbed(updated));
  const notified = await notifyApplicant(interaction.client, updated, makeEmbed(config.EMBED_COLORS.warning, 'More Information Requested', `Management requests more information for application ${applicationCode(applicationId)}:\n\n${message}\n\nUse \/tempadmin respond application-id:${applicationId} text:<your response>.`));
  return interaction.reply({ content: `Information requested for ${applicationCode(applicationId)}.${notified ? ' The applicant was sent a DM.' : ' The applicant DM failed; the review status was still saved.'}`, ephemeral: true });
}

async function claimApplicationForApproval(db, application, reviewerId, reviewedAt) {
  return db.prepare(`
    UPDATE temporary_admin_applications SET status = 'approving', reviewed_at = ?, reviewer_id = ?
    WHERE id = ? AND status = 'pending' AND review_state != 'on_hold'
  `).run(reviewedAt, reviewerId, application.id).changes > 0;
}

async function handleApproval(interaction, ctx, applicationId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'pending' AND review_state != 'on_hold'").get(applicationId);
  if (!application) {
    const current = ctx.db.prepare('SELECT review_state FROM temporary_admin_applications WHERE id = ?').get(applicationId);
    return interaction.reply({ content: current?.review_state === 'on_hold' ? 'This application is on hold. Resume review before approving it.' : 'This application was already reviewed or could not be found.', ephemeral: true });
  }
  const reviewedAt = new Date().toISOString();
  if (!await claimApplicationForApproval(ctx.db, application, interaction.user.id, reviewedAt)) {
    return interaction.reply({ content: 'This application is already being reviewed.', ephemeral: true });
  }

  let member;
  let role;
  let assigned = false;
  try {
    member = await interaction.guild.members.fetch(application.applicant_id);
    role = await interaction.guild.roles.fetch(application.requested_role_id);
    const botMember = interaction.guild.members.me;
    if (!role || role.managed || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)
      || !botMember.roles.highest || role.position >= botMember.roles.highest.position) {
      throw new Error('The configured role is unavailable or above the bot’s role. Check Manage Roles and role hierarchy.');
    }
    if (member.roles.cache.has(role.id)) throw new Error('The applicant already has the role being requested.');
    await member.roles.add(role, `Temporary Admin application ${applicationCode(applicationId)} approved by ${interaction.user.username}`);
    assigned = true;
    const expiresAt = new Date(Date.parse(reviewedAt) + application.duration_hours * 3600_000).toISOString();
    ctx.db.transaction(() => {
      const result = ctx.db.prepare(`
        UPDATE temporary_admin_applications SET status = 'approved', review_state = 'approved', expires_at = ?,
          trial_started_at = ?, trial_duration_hours = ?, assigned_manager_id = ?, trial_extensions = 0
        WHERE id = ? AND status = 'approving'
      `).run(expiresAt, reviewedAt, application.duration_hours, interaction.user.id, applicationId);
      if (!result.changes) throw new Error('Application approval could not be finalized.');
      addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'approved', {
        roleId: role.id, durationHours: application.duration_hours, expiresAt,
      }, reviewedAt);
    })();
  } catch (error) {
    if (assigned && member && role) {
      await member.roles.remove(role, `Rolling back incomplete approval ${applicationCode(applicationId)}`).catch((removeError) => {
        console.error('Could not roll back a Temporary Admin role after an approval error:', removeError.message);
      });
    }
    ctx.db.prepare(`
      UPDATE temporary_admin_applications SET status = 'pending', reviewed_at = NULL, reviewer_id = NULL
      WHERE id = ? AND status = 'approving'
    `).run(applicationId);
    return interaction.reply({ content: `Approval was not completed: ${error.message}`, ephemeral: true });
  }

  const approved = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  const embed = decisionEmbed(approved, true);
  await interaction.update({ embeds: [embed], components: [] });
  if (!await notifyApplicant(interaction.client, approved, embed)) {
    await interaction.followUp({ content: 'Role assigned and application approved, but the applicant’s DMs are unavailable. They can view the decision privately with `/tempadmin history`.', ephemeral: true }).catch(() => {});
  }
}

async function submitDenial(interaction, ctx, applicationId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'pending' AND review_state != 'on_hold'").get(applicationId);
  if (!application) return interaction.reply({ content: 'This application was already reviewed or could not be found.', ephemeral: true });
  const reason = interaction.fields.getTextInputValue('reason').trim() || 'No reason provided.';
  const reviewedAt = new Date().toISOString();
  const changed = ctx.db.transaction(() => {
      const result = ctx.db.prepare(`
        UPDATE temporary_admin_applications SET status = 'denied', review_state = 'denied', reviewed_at = ?, reviewer_id = ?, decision_reason = ?
      WHERE id = ? AND status = 'pending' AND review_state != 'on_hold'
    `).run(reviewedAt, interaction.user.id, reason, applicationId);
    if (!result.changes) return false;
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'denied', { reason }, reviewedAt);
    return true;
  })();
  if (!changed) return interaction.reply({ content: 'This application was already reviewed.', ephemeral: true });

  const denied = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  const embed = decisionEmbed(denied, false);
  await updateReviewMessage(interaction.client, denied, embed);
  if (!await notifyApplicant(interaction.client, denied, embed)) {
    return interaction.reply({ content: 'Application denied. The applicant’s DMs are unavailable; they can view the decision privately with `/tempadmin history`.', ephemeral: true });
  }
  return interaction.reply({ content: `Application ${applicationCode(applicationId)} denied and the applicant was notified privately.`, ephemeral: true });
}

function applicationHistoryEmbed(applicantId, rows, includeManagementNotes = false) {
  const description = rows.length
    ? rows.map((row) => {
      const expiration = row.expires_at ? `\nTrial ends: <t:${Math.floor(new Date(row.expires_at).getTime() / 1000)}:F>` : '';
      const started = row.trial_started_at ? `\nTrial started: <t:${Math.floor(new Date(row.trial_started_at).getTime() / 1000)}:F>` : '';
      const manager = row.assigned_manager_id ? `\nAssigned manager: <@${row.assigned_manager_id}>` : '';
      const extensions = row.trial_extensions ? `\nExtensions: ${row.trial_extensions}` : '';
      const reason = row.decision_reason ? `\nReason: ${row.decision_reason}` : '';
      const notes = includeManagementNotes && row.management_notes ? `\n**Private notes:** ${row.management_notes.slice(0, 700)}` : '';
      const reviewState = row.review_state && row.review_state !== row.status ? ` • ${row.review_state.replaceAll('_', ' ').toUpperCase()}` : '';
      return `**${applicationCode(row.id)} • ${row.status.toUpperCase()}${reviewState}**\nSubmitted <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>${started}${expiration}${manager}${extensions}${row.trial_outcome ? `\nOutcome: ${row.trial_outcome}` : ''}${reason}${notes}`;
    }).join('\n\n')
    : 'No Temporary Admin applications were found.';
  return makeEmbed(config.EMBED_COLORS.info, `📄 Temporary Admin History • ${applicantId}`, description.slice(0, 4000));
}

async function showApplicationHistory(interaction, ctx) {
  const target = interaction.options.getUser('member');
  if (target && target.id !== interaction.user.id && !await ensureManagement(interaction, ctx.db)) return;
  const applicantId = target?.id ?? interaction.user.id;
  const rows = ctx.db.prepare(`
    SELECT id, status, review_state, created_at, expires_at, trial_started_at, trial_extensions, trial_outcome, assigned_manager_id, decision_reason, management_notes
    FROM temporary_admin_applications WHERE applicant_id = ? ORDER BY id DESC LIMIT 10
  `).all(applicantId);
  return interaction.reply({ embeds: [applicationHistoryEmbed(target?.username ?? interaction.user.username, rows, Boolean(target && target.id !== interaction.user.id))], ephemeral: true });
}

async function searchApplications(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const query = interaction.options.getString('query', true).trim();
  const rows = ctx.db.prepare(`
    SELECT id, applicant_id, applicant_name, status, review_state, created_at, expires_at, decision_reason, management_notes
    FROM temporary_admin_applications
    WHERE CAST(id AS TEXT) LIKE ? OR applicant_id LIKE ? OR applicant_name LIKE ? OR answers_json LIKE ? OR status LIKE ? OR review_state LIKE ?
    ORDER BY id DESC LIMIT 25
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
  const description = rows.length ? rows.map((row) => `**${applicationCode(row.id)} • ${row.status.toUpperCase()} / ${(row.review_state ?? 'pending').replaceAll('_', ' ')}**\n<@${row.applicant_id}> • ${row.applicant_name}\nSubmitted <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>${row.expires_at ? ` • Trial ends <t:${Math.floor(new Date(row.expires_at).getTime() / 1000)}:R>` : ''}${row.decision_reason ? `\n${row.decision_reason}` : ''}${row.management_notes ? `\nPrivate notes: ${row.management_notes.slice(0, 300)}` : ''}`).join('\n\n') : 'No applications matched that search.';
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.management, 'Temporary Admin Application Search', description.slice(0, 3900))], ephemeral: true });
}

async function respondToApplication(interaction, ctx) {
  const applicationId = interaction.options.getInteger('application-id', true);
  const response = interaction.options.getString('text', true).trim();
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND applicant_id = ? AND status = 'pending' AND review_state = 'info_requested'").get(applicationId, interaction.user.id);
  if (!application) return interaction.reply({ content: 'No information request is waiting for this application.', ephemeral: true });
  const now = new Date().toISOString();
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE temporary_admin_applications SET review_state = 'pending', decision_reason = '' WHERE id = ? AND status = 'pending'").run(applicationId);
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'applicant_information_submitted', { response }, now);
  })();
  const channel = application.review_channel_id ? await interaction.client.channels.fetch(application.review_channel_id).catch(() => null) : null;
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [makeEmbed(config.EMBED_COLORS.info, `Additional Information • ${applicationCode(applicationId)}`, `**Applicant:** <@${interaction.user.id}>\n${response}`)], allowedMentions: { users: [interaction.user.id] } }).catch(() => {});
  }
  const refreshed = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  await updateReviewMessage(interaction.client, refreshed, applicationReviewEmbed(refreshed));
  return interaction.reply({ content: 'Your response was sent to management.', ephemeral: true });
}

async function startTrial(interaction, ctx, applicationId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'approved'").get(applicationId);
  if (!application) return interaction.reply({ content: 'Approved application not found.', ephemeral: true });
  if (application.trial_started_at) return interaction.reply({ content: `This trial already started <t:${Math.floor(new Date(application.trial_started_at).getTime() / 1000)}:R>.`, ephemeral: true });
  let member;
  try { member = await interaction.guild.members.fetch(application.applicant_id); }
  catch { return interaction.reply({ content: 'The applicant is no longer in this server.', ephemeral: true }); }
  const role = await interaction.guild.roles.fetch(application.requested_role_id).catch(() => null);
  const botMember = interaction.guild.members.me;
  if (!role || role.managed || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || !botMember.roles.highest || role.position >= botMember.roles.highest.position) {
    return interaction.reply({ content: 'The configured temporary role is unavailable or above the bot’s role.', ephemeral: true });
  }
  if (!member.roles.cache.has(role.id)) await member.roles.add(role, `Starting Temporary Admin trial ${applicationCode(applicationId)}`);
  const now = new Date();
  const duration = application.trial_duration_hours ?? application.duration_hours;
  const expiresAt = new Date(now.getTime() + duration * 3600_000).toISOString();
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE temporary_admin_applications SET trial_started_at = ?, trial_duration_hours = ?, expires_at = ?, assigned_manager_id = ?, trial_reminder_sent_at = NULL WHERE id = ? AND status = \'approved\'')
      .run(now.toISOString(), duration, expiresAt, interaction.user.id, applicationId);
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'trial_started', { durationHours: duration, expiresAt }, now.toISOString());
  })();
  const updated = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  await notifyApplicant(interaction.client, updated, decisionEmbed(updated, true));
  return interaction.reply({ content: `Trial ${applicationCode(applicationId)} started. It ends <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:F>.`, ephemeral: true });
}

async function extendTrial(interaction, ctx, applicationId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const hours = interaction.options.getInteger('hours', true);
  const reason = interaction.options.getString('reason', true).trim();
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'approved' AND trial_started_at IS NOT NULL").get(applicationId);
  if (!application) return interaction.reply({ content: 'An active Temporary Admin trial was not found.', ephemeral: true });
  const base = Math.max(Date.now(), Date.parse(application.expires_at));
  const expiresAt = new Date(base + hours * 3600_000).toISOString();
  const now = new Date().toISOString();
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE temporary_admin_applications SET expires_at = ?, trial_duration_hours = trial_duration_hours + ?, trial_extensions = trial_extensions + 1, assigned_manager_id = ?, trial_reminder_sent_at = NULL WHERE id = ? AND status = \'approved\'')
      .run(expiresAt, hours, interaction.user.id, applicationId);
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'trial_extended', { hours, reason, expiresAt }, now);
  })();
  const updated = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  await notifyApplicant(interaction.client, updated, makeEmbed(config.EMBED_COLORS.info, 'Temporary Admin Trial Extended', `Your trial was extended by ${hours} hours. New end: <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:F>.\nReason: ${reason}`));
  return interaction.reply({ content: `Trial extended. New end: <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:F>.`, ephemeral: true });
}

async function finishTrial(interaction, ctx, applicationId, reason, promoteRole = null) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'approved'").get(applicationId);
  if (!application) return interaction.reply({ content: 'An active Temporary Admin trial was not found.', ephemeral: true });
  let member;
  try { member = await interaction.guild.members.fetch(application.applicant_id); }
  catch { return interaction.reply({ content: 'The applicant is no longer in this server.', ephemeral: true }); }
  const botMember = interaction.guild.members.me;
  let regularRole;
  if (promoteRole) {
    regularRole = await interaction.guild.roles.fetch(promoteRole.id).catch(() => null);
    if (!regularRole || regularRole.managed || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || !botMember.roles.highest || regularRole.position >= botMember.roles.highest.position) {
      return interaction.reply({ content: 'The regular staff role is unavailable or above the bot’s role.', ephemeral: true });
    }
  }
  const temporaryRole = await interaction.guild.roles.fetch(application.requested_role_id).catch(() => null);
  if (promoteRole) await member.roles.add(regularRole, `Temporary Admin trial ${applicationCode(applicationId)} completed`);
  if (temporaryRole && member.roles.cache.has(temporaryRole.id)) await member.roles.remove(temporaryRole, `Temporary Admin trial ${applicationCode(applicationId)} ended`);
  const now = new Date().toISOString();
  const outcome = promoteRole ? 'promoted' : 'ended';
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE temporary_admin_applications SET status = 'expired', review_state = 'trial_completed', trial_outcome = ? WHERE id = ? AND status = 'approved'").run(outcome, applicationId);
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, outcome, { reason, regularRoleId: promoteRole?.id ?? null }, now);
  })();
  const updated = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  await notifyApplicant(interaction.client, updated, makeEmbed(promoteRole ? config.EMBED_COLORS.active : config.EMBED_COLORS.info, promoteRole ? 'Temporary Admin Trial Approved' : 'Temporary Admin Trial Ended', promoteRole ? `You completed your Temporary Admin trial and were assigned <@&${promoteRole.id}>.` : `Your temporary role trial has ended.\nOutcome: ${reason}`));
  return interaction.reply({ content: promoteRole ? `Trial completed and <@${promoteRole.id}> assigned.` : 'Trial ended and the temporary role was removed.', ephemeral: true });
}

async function addManagementNote(interaction, ctx, applicationId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const text = interaction.options.getString('text', true).trim();
  const application = ctx.db.prepare('SELECT management_notes FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  if (!application) return interaction.reply({ content: 'Application not found.', ephemeral: true });
  const now = new Date().toISOString();
  const notes = `${application.management_notes ? `${application.management_notes}\n` : ''}[${now}] ${interaction.user.id}: ${text}`;
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE temporary_admin_applications SET management_notes = ? WHERE id = ?').run(notes, applicationId);
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'management_note_added', { note: text }, now);
  })();
  return interaction.reply({ content: 'Private management note saved.', ephemeral: true });
}

async function handleTempAdminCommand(interaction, ctx) {
  if (interaction.commandName !== 'tempadmin') return null;
  const action = interaction.options.getSubcommand();
  if (action === 'history') return showApplicationHistory(interaction, ctx);
  if (action === 'search') return searchApplications(interaction, ctx);
  if (action === 'respond') return respondToApplication(interaction, ctx);
  if (action.startsWith('question-')) return manageQuestions(interaction, ctx, action);
  if (action === 'trial-start') return startTrial(interaction, ctx, interaction.options.getInteger('application-id', true));
  if (action === 'trial-extend') return extendTrial(interaction, ctx, interaction.options.getInteger('application-id', true));
  if (action === 'trial-end') return finishTrial(interaction, ctx, interaction.options.getInteger('application-id', true), interaction.options.getString('reason', true));
  if (action === 'promote') return finishTrial(interaction, ctx, interaction.options.getInteger('application-id', true), interaction.options.getString('reason', true), interaction.options.getRole('role', true));
  if (action === 'note') return addManagementNote(interaction, ctx, interaction.options.getInteger('application-id', true));
  if (action === 'notes') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const applicationId = interaction.options.getInteger('application-id', true);
    const row = ctx.db.prepare('SELECT management_notes FROM temporary_admin_applications WHERE id = ?').get(applicationId);
    return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.management, `Private Notes • ${applicationCode(applicationId)}`, row?.management_notes || 'No private management notes have been added.')], ephemeral: true });
  }
  if (action === 'preview') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const settings = getApplicationSettings(ctx.db);
    return interaction.reply({ embeds: [applicationPanelEmbed(settings)], components: applicationPanelComponents(), ephemeral: true });
  }
  if (action === 'panel') return openApplicationPanel(interaction, ctx);
  if (action === 'configure') return configureApplications(interaction, ctx);
  return interaction.reply({ content: 'That Temporary Admin command is not available.', ephemeral: true });
}

async function handleTempAdminButton(interaction, ctx) {
  if (interaction.customId === 'gv:tempadmin:apply') return startApplication(interaction, ctx);
  const cancelMatch = interaction.customId.match(/^gv:tempadmin:cancel:([a-f0-9]{32})$/);
  if (cancelMatch) return cancelApplicationDraft(interaction, ctx, cancelMatch[1]);
  const continueMatch = interaction.customId.match(/^gv:tempadmin:continue:([a-f0-9]{32}):(\d+)$/);
  if (continueMatch) {
    const draft = getApplicationDraft(ctx.db, continueMatch[1], interaction.user.id);
    if (!draft) return interaction.reply({ content: 'This application form expired. Reopen the panel to start again.', ephemeral: true });
    const page = Number(continueMatch[2]);
    const pageCount = Math.ceil(draft.settings.questions.length / applicationQuestionsPerPage);
    if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) return interaction.reply({ content: 'This application page is invalid.', ephemeral: true });
    return continueApplicationPage(interaction, ctx, continueMatch[1], page);
  }
  const submitMatch = interaction.customId.match(/^gv:tempadmin:submit:([a-f0-9]{32}):(\d+)$/);
  if (submitMatch) return submitChoiceApplication(interaction, ctx, submitMatch[1], Number(submitMatch[2]));
  const match = interaction.customId.match(/^gv:tempadmin:(approve|deny|info|hold|resume):(\d+)$/);
  if (!match) return interaction.reply({ content: 'This Temporary Admin control is not recognized.', ephemeral: true });
  const applicationId = Number(match[2]);
  if (!Number.isSafeInteger(applicationId) || applicationId < 1) {
    return interaction.reply({ content: 'This application control is invalid.', ephemeral: true });
  }
  if (match[1] === 'approve') return handleApproval(interaction, ctx, applicationId);
  if (match[1] === 'hold') return setReviewState(interaction, ctx, applicationId, 'on_hold');
  if (match[1] === 'resume') return setReviewState(interaction, ctx, applicationId, 'pending');
  if (match[1] === 'info') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const pending = ctx.db.prepare("SELECT id FROM temporary_admin_applications WHERE id = ? AND status = 'pending' AND review_state != 'on_hold'").get(applicationId);
    if (!pending) return interaction.reply({ content: 'This application is no longer available for review.', ephemeral: true });
    return interaction.showModal(moreInformationModal(applicationId));
  }
  if (!await ensureManagement(interaction, ctx.db)) return;
  const pending = ctx.db.prepare("SELECT id FROM temporary_admin_applications WHERE id = ? AND status = 'pending' AND review_state != 'on_hold'").get(applicationId);
  if (!pending) return interaction.reply({ content: 'This application was already reviewed or could not be found.', ephemeral: true });
  return interaction.showModal(denialModal(applicationId));
}

async function handleTempAdminModal(interaction, ctx) {
  const applicationMatch = interaction.customId.match(/^gv:tempadmin:apply:([a-f0-9]{32})(?::(\d+))?$/);
  if (applicationMatch) return submitApplication(interaction, ctx, applicationMatch[1], Number(applicationMatch[2] ?? 0));
  const denialMatch = interaction.customId.match(/^gv:tempadmin:deny_submit:(\d+)$/);
  if (denialMatch) return submitDenial(interaction, ctx, Number(denialMatch[1]));
  const infoMatch = interaction.customId.match(/^gv:tempadmin:info_submit:(\d+)$/);
  if (infoMatch) return submitMoreInformationRequest(interaction, ctx, Number(infoMatch[1]));
  return null;
}

function finalizeExpiredApplication(db, application, actorId, nowIso, details = {}) {
  db.transaction(() => {
    const outcome = details.outcome ?? 'expired';
    const result = db.prepare("UPDATE temporary_admin_applications SET status = 'expired', review_state = 'trial_completed', trial_outcome = ? WHERE id = ? AND status = 'expiring'")
      .run(outcome, application.id);
    if (result.changes) addApplicationHistory(db, application.id, actorId, 'expired', details, nowIso);
  })();
}

async function processTemporaryAdminExpirations(client, db, now = new Date()) {
  let guild = client.guilds?.cache?.get(config.SERVER_ID);
  if (!guild) {
    try {
      guild = await client.guilds.fetch(config.SERVER_ID);
    } catch (error) {
      console.error('Could not load server for Temporary Admin expiration processing:', error.message);
      return 0;
    }
  }
  const nowIso = now.toISOString();
  const reminderHours = Number(getConfigValue(db, 'TEMP_ADMIN_TRIAL_REMINDER_HOURS') ?? config.TEMP_ADMIN_TRIAL_REMINDER_HOURS ?? 12);
  if (Number.isSafeInteger(reminderHours) && reminderHours > 0) {
    const reminderCutoff = new Date(now.getTime() + reminderHours * 3600_000).toISOString();
    const reminders = db.prepare(`
      SELECT * FROM temporary_admin_applications
      WHERE status = 'approved' AND trial_started_at IS NOT NULL AND expires_at > ? AND expires_at <= ?
        AND trial_reminder_sent_at IS NULL
    `).all(nowIso, reminderCutoff);
    for (const application of reminders) {
      const claimed = db.prepare(`UPDATE temporary_admin_applications SET trial_reminder_sent_at = ?
        WHERE id = ? AND status = 'approved' AND trial_reminder_sent_at IS NULL`).run(nowIso, application.id);
      if (!claimed.changes) continue;
      const reminder = makeEmbed(config.EMBED_COLORS.warning, `⏰ Trial Ending Soon • ${applicationCode(application.id)}`,
        `<@${application.applicant_id}>'s Temporary Admin trial ends <t:${Math.floor(new Date(application.expires_at).getTime() / 1000)}:R>.\nAssigned manager: ${application.assigned_manager_id ? `<@${application.assigned_manager_id}>` : 'Not assigned'}\nUse \/tempadmin trial-extend, trial-end, or promote to record an outcome.`);
      try {
        const channel = application.review_channel_id ? await client.channels.fetch(application.review_channel_id) : null;
        if (channel?.isTextBased()) await channel.send({ embeds: [reminder], allowedMentions: { users: [application.applicant_id] } });
      } catch (error) { console.error(`Could not send trial reminder for ${applicationCode(application.id)}:`, error.message); }
    }
  }

  for (const application of db.prepare("SELECT * FROM temporary_admin_applications WHERE status = 'approving'").all()) {
    try {
      const member = await guild.members.fetch(application.applicant_id);
      const hasRole = member.roles.cache.has(application.requested_role_id);
      if (!hasRole) {
        db.prepare(`
          UPDATE temporary_admin_applications SET status = 'pending', reviewed_at = NULL, reviewer_id = NULL
          WHERE id = ? AND status = 'approving'
        `).run(application.id);
        continue;
      }
      const expiresAt = new Date(Date.parse(application.reviewed_at) + application.duration_hours * 3600_000).toISOString();
      db.transaction(() => {
        const result = db.prepare(`
          UPDATE temporary_admin_applications SET status = 'approved', review_state = 'approved', expires_at = ?,
            trial_started_at = COALESCE(trial_started_at, reviewed_at), trial_duration_hours = COALESCE(trial_duration_hours, duration_hours),
            assigned_manager_id = COALESCE(assigned_manager_id, reviewer_id), trial_extensions = COALESCE(trial_extensions, 0)
          WHERE id = ? AND status = 'approving'
          `).run(expiresAt, application.id);
        if (result.changes) addApplicationHistory(db, application.id, application.reviewer_id, 'approval_recovered', { expiresAt }, nowIso);
      })();
    } catch (error) {
      console.error(`Could not recover Temporary Admin application ${applicationCode(application.id)}:`, error.message);
    }
  }

  const expired = db.prepare(`
    SELECT * FROM temporary_admin_applications
    WHERE status = 'expiring' OR (status = 'approved' AND expires_at IS NOT NULL AND expires_at <= ?)
    ORDER BY expires_at
  `).all(nowIso);
  let completed = 0;
  for (const application of expired) {
    if (application.status === 'approved') {
      const claimed = db.prepare(`
        UPDATE temporary_admin_applications SET status = 'expiring'
        WHERE id = ? AND status = 'approved' AND expires_at <= ?
      `).run(application.id, nowIso);
      if (!claimed.changes) continue;
    }
    let member;
    try {
      member = await guild.members.fetch(application.applicant_id);
    } catch (error) {
      if (error.code === 10007) {
        finalizeExpiredApplication(db, application, 'system', nowIso, { reason: 'Applicant is no longer in the server.' });
        await notifyApplicant(client, application, makeEmbed(config.EMBED_COLORS.info, 'Temporary Admin Trial Ended', 'Your trial has ended because you left the GV GR server.'));
        completed += 1;
      } else {
        db.prepare("UPDATE temporary_admin_applications SET status = 'approved' WHERE id = ? AND status = 'expiring'").run(application.id);
        console.error(`Could not fetch Temporary Admin applicant ${application.applicant_id}:`, error.message);
      }
      continue;
    }
    try {
      if (member.roles.cache.has(application.requested_role_id)) {
        await member.roles.remove(application.requested_role_id, `Temporary Admin application ${applicationCode(application.id)} expired`);
      }
      finalizeExpiredApplication(db, application, 'system', nowIso, { roleId: application.requested_role_id });
      await notifyApplicant(client, application, makeEmbed(config.EMBED_COLORS.info, 'Temporary Admin Trial Ended', `Your Temporary Admin trial ${applicationCode(application.id)} ended. Management will review the trial outcome; expiry does not automatically promote you.`));
      completed += 1;
    } catch (error) {
      db.prepare("UPDATE temporary_admin_applications SET status = 'approved' WHERE id = ? AND status = 'expiring'").run(application.id);
      console.error(`Could not remove expired Temporary Admin role from ${application.applicant_id}:`, error.message);
    }
  }
  return completed;
}

module.exports = {
  applicationPanelComponents,
  applicationPanelEmbed,
  createApplicationDraft,
  createApplicationModal,
  getApplicationSettings,
  handleTempAdminButton,
  handleTempAdminCommand,
  handleTempAdminModal,
  handleTempAdminSelect,
  processTemporaryAdminExpirations,
};