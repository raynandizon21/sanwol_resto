// Run: cd server && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { deviceNameFor, cleanDeviceName, readProfile, charCount, DEVICE_NAME_MAX } = require('../utils/employeeProfile');

test('device name: full name when it fits', () => {
	assert.equal(deviceNameFor('Juan', 'Dela Cruz'), 'Juan Dela Cruz');
	assert.equal(deviceNameFor('Ñoño', ''), 'Ñoño');
});

test('device name: last-name initial when the full name is too long', () => {
	assert.equal(deviceNameFor('Maria Clara Josefina', 'Dela Cruz-Santos'), 'Maria Clara Josefina D.');
	assert.equal(deviceNameFor('Juan Carlos', 'Pérez-Rodríguez de la Fuente'), 'Juan Carlos P.');
});

test('device name: drops whole first-name words before cutting a word', () => {
	assert.equal(deviceNameFor('Christopher Alexander Montgomery', 'Smith'), 'Christopher Alexander S.');
	assert.equal(deviceNameFor('Christopher Alexander Montgomery', ''), 'Christopher Alexander');
});

test('device name: one very long word is cut to 24 characters', () => {
	assert.equal(deviceNameFor('Supercalifragilisticexpialidocious', 'X'), 'Supercalifragilisticexpi');
});

test('device name: no first name falls back to the last name; nothing gives empty', () => {
	assert.equal(deviceNameFor('', 'Solo'), 'Solo');
	assert.equal(deviceNameFor('', ''), '');
});

test('device name: tabs, line breaks and extra spaces are cleaned', () => {
	assert.equal(deviceNameFor('  Ana \t', ' Li\n'), 'Ana Li');
	assert.equal(cleanDeviceName('A\tB\r\nC'), 'A B C');
});

test('device name: never over the limit, never splits a character', () => {
	const names = [
		['Maria Clara Josefina Ma', 'Reyes'],
		['😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀', 'Z'],
		['Ab Cd Ef Gh Ij Kl Mn Op Qr', 'Stuvwxyz'],
	];
	for (const [first, last] of names) {
		const name = deviceNameFor(first, last);
		assert.ok(charCount(name) <= DEVICE_NAME_MAX && charCount(name) > 0, name);
		assert.ok(!name.includes('�'));
	}
});

test('profile: first name required when sent; dates validated', () => {
	assert.equal(readProfile({ first_name: ' ' }).error, 'First name is required');
	assert.equal(readProfile({ date_started: '2026-02-30' }).error, 'Dates must be YYYY-MM-DD');
	assert.equal(readProfile({ date_started: '2026-05-01', date_separated: '2026-04-30' }).error, 'The last day of work is before the hire date');
	assert.equal(readProfile({ date_separated: '2026-04-30' }, { DATE_STARTED: '2026-05-01' }).error, 'The last day of work is before the hire date');
	const { fields } = readProfile({ first_name: ' Juan ', last_name: '', position: 'Kitchen', date_started: '' });
	assert.deepEqual(fields, { FIRSTNAME: 'Juan', LASTNAME: null, DEPARTMENT: 'Kitchen', DATE_STARTED: null });
});

test('profile: fields that no longer exist are ignored', () => {
	const { fields, error } = readProfile({ first_name: 'A', employment_type: 'regular', shift_start: '08:00', rest_days: [0] });
	assert.equal(error, undefined);
	assert.deepEqual(fields, { FIRSTNAME: 'A' });
});
