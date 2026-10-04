const { ONGOING, CANCELLED } = require('./adminDashboard');

/** Trip statuses grouped the way an operator thinks about them. */
const STATUS_GROUPS = {
  searching: ['REQUESTED'],
  active: ONGOING,
  completed: ['COMPLETED'],
  cancelled: CANCELLED,
  unanswered: ['REJECTED', 'REJECTED_WITH_REASON', 'NO_RESPONSE']
};

const groupOf = (status) => Object.keys(STATUS_GROUPS).find((g) => STATUS_GROUPS[g].includes(status)) || 'other';

/** Statuses a trip can still leave (an admin may cancel these); completed, cancelled and declined trips are final. */
const OPEN_STATUSES = ['REQUESTED', 'ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];

module.exports = { STATUS_GROUPS, groupOf, OPEN_STATUSES };
