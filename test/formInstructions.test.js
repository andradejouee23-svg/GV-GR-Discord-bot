const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDatabase } = require('../src/database');
const { makeSessionModal, makeSessionPanelModal } = require('../src/commands/operations');
const { reportModal } = require('../src/commands/safety');
const { applicationBasicModal } = require('../src/commands/vehicles');
const {
  getFormQuestion,
  handleFormsCommand,
  handleFormsModal,
  handleFormsSelect,
  openFormsDashboard,
} = require('../src/commands/forms');
const { setConfigValue } = require('../src/utils/discord');

function modalInputs(modal) {
  return modal.toJSON().components.flatMap((row) => row.components);
}

test('Forms Manager saves question labels and examples and applies them to real modals after restart', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-forms-'));
  const databasePath = path.join(directory, 'forms.sqlite');
  let db = createDatabase(databasePath);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const managerId = 'forms-manager';
  const roleId = '1556064708795306157';
  setConfigValue(db, 'role_management', [roleId]);
  const guild = {
    id: '1551269087492047058',
    ownerId: 'owner',
    members: { fetch: async (id) => id === managerId ? { id, roles: { cache: new Map([[roleId, {}]]) } } : null },
  };
  const edited = await handleFormsCommand({
    commandName: 'forms',
    options: {
      getSubcommand: () => 'edit',
      getString: (name) => ({ form: 'report', question: 'reason', label: 'Report category', placeholder: 'Example: harassment or exploiting.' })[name] ?? null,
    },
    guild,
    user: { id: managerId },
    reply: async (payload) => payload,
  }, { db });
  assert.match(edited.content, /Saved/);
  const manager = { id: managerId, roles: { cache: new Map([[roleId, {}]]) } };
  const managerInteraction = (properties = {}) => ({
    guild,
    user: { id: managerId },
    ...properties,
  });
  const dashboard = await openFormsDashboard(managerInteraction({ reply: async (payload) => payload }), { db });
  assert.equal(dashboard.components[0].components[0].toJSON().custom_id, 'mgmt:forms:select');
  let questions;
  await handleFormsSelect(managerInteraction({
    customId: 'mgmt:forms:select',
    values: ['vehicle_registration'],
    update: async (payload) => { questions = payload; return payload; },
  }), { db });
  let questionModal;
  await handleFormsSelect(managerInteraction({
    customId: questions.components[0].components[0].toJSON().custom_id,
    values: ['vehicle'],
    showModal: async (modal) => { questionModal = modal; return modal; },
  }), { db });
  assert.match(modalInputs(questionModal)[0].value, /Vehicle make and model/);
  await handleFormsModal(managerInteraction({
    customId: questionModal.data.custom_id,
    fields: { getTextInputValue: (key) => ({ label: 'Vehicle model', placeholder: 'Example: 2024 Ford Explorer.' })[key] },
    reply: async (payload) => payload,
  }), { db });
  db.close();
  db = createDatabase(databasePath);

  const report = modalInputs(reportModal(db));
  assert.equal(report.find((input) => input.custom_id === 'reason').required, true);
  assert.equal(report.find((input) => input.custom_id === 'reason').label, 'Report category');
  assert.match(report.find((input) => input.custom_id === 'evidence').placeholder, /screenshot/i);
  assert.equal(report.find((input) => input.custom_id === 'evidence').required, false);

  const session = modalInputs(makeSessionModal({ id: 'staff-member' }, db));
  assert.match(session.find((input) => input.custom_id === 'name').placeholder, /Community Patrol/);
  assert.equal(session.find((input) => input.custom_id === 'description').required, false);
  assert.match(modalInputs(makeSessionPanelModal('staff-member', db))[1].placeholder, /meeting point/i);

  const vehicle = modalInputs(applicationBasicModal(db));
  assert.match(vehicle.find((input) => input.custom_id === 'roblox').placeholder, /exact Roblox username/i);
  assert.match(vehicle.find((input) => input.custom_id === 'vehicle').placeholder, /2024 Ford Explorer/i);
  assert.equal(vehicle.find((input) => input.custom_id === 'vehicle').label, 'Vehicle model');
  assert.match(vehicle.find((input) => input.custom_id === 'vehicle').placeholder, /2024 Ford Explorer/);
  assert.equal(vehicle.find((input) => input.custom_id === 'plate').required, true);
  assert.equal(getFormQuestion(db, 'report', 'reason').label, 'Report category');
});