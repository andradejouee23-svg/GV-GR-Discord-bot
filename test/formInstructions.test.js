const assert = require('node:assert/strict');
const test = require('node:test');
const { blacklistCreateModal, blacklistDetailsModal } = require('../src/commands/blacklist');
const { createApplicationModal } = require('../src/commands/tempAdmin');
const { makeSessionModal, makeSessionPanelModal } = require('../src/commands/operations');
const { reportModal } = require('../src/commands/safety');
const { applicationBasicModal } = require('../src/commands/vehicles');

function modalInputs(modal) {
  return modal.toJSON().components.flatMap((row) => row.components);
}

test('player and staff forms show concise examples without changing required fields', () => {
  const report = modalInputs(reportModal());
  assert.match(report.find((input) => input.custom_id === 'player').placeholder, /exact Discord or Roblox username/i);
  assert.equal(report.find((input) => input.custom_id === 'reason').required, true);
  assert.match(report.find((input) => input.custom_id === 'evidence').placeholder, /screenshot/i);
  assert.equal(report.find((input) => input.custom_id === 'evidence').required, false);

  const session = modalInputs(makeSessionModal({ id: 'staff-member' }));
  assert.match(session.find((input) => input.custom_id === 'name').placeholder, /Community Patrol/);
  assert.equal(session.find((input) => input.custom_id === 'description').required, false);
  assert.match(modalInputs(makeSessionPanelModal('staff-member'))[1].placeholder, /meeting point/i);

  const vehicle = modalInputs(applicationBasicModal());
  assert.match(vehicle.find((input) => input.custom_id === 'roblox').placeholder, /exact Roblox username/i);
  assert.match(vehicle.find((input) => input.custom_id === 'vehicle').placeholder, /2023 Chevrolet Tahoe/i);
  assert.equal(vehicle.find((input) => input.custom_id === 'plate').required, true);

  const blacklist = modalInputs(blacklistCreateModal('a'.repeat(32)));
  assert.match(blacklist.find((input) => input.custom_id === 'reason').placeholder, /relevant rule/i);
  const details = modalInputs(blacklistDetailsModal('a'.repeat(32)));
  assert.match(details.find((input) => input.custom_id === 'evidence').placeholder, /screenshots/i);
  assert.equal(details.find((input) => input.custom_id === 'staff_notes').required, false);

  const application = modalInputs(createApplicationModal('a'.repeat(32), {
    title: 'Temporary Admin Application',
    questions: [
      { label: 'What is your Roblox username?', type: 'short', required: true },
      { label: 'Why do you want to join?', type: 'paragraph', required: true },
    ],
  }));
  assert.match(application[0].placeholder, /exact Roblox username/i);
  assert.match(application[1].placeholder, /relevant details/i);
  assert.equal(application[0].required, true);
});