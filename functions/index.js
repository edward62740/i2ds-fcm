'use strict';
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const PromisePool = require('es6-promise-pool');
// Maximum concurrent account deletions.
const MAX_CONCURRENT = 3;





/**
* Run once a day at midnight, to cleanup the users
* Manually run the task here https://console.cloud.google.com/cloudscheduler
*/
exports.I2DSaccountCleanup = functions.pubsub.schedule('every day 00:00').onRun(async context => {
  // Fetch all user details.
  const inactiveUsers = await getInactiveUsers();
  // Use a pool so that we delete maximum `MAX_CONCURRENT` users in parallel.
  const promisePool = new PromisePool(() => deleteInactiveUser(inactiveUsers), MAX_CONCURRENT);
  await promisePool.start();
  functions.logger.log('User cleanup finished');
});

/**
 * Deletes one inactive user from the list.
 */
function deleteInactiveUser(inactiveUsers) {
  if (inactiveUsers.length > 0) {
    const userToDelete = inactiveUsers.pop();

    // Delete the inactive user.
    return admin.auth().deleteUser(userToDelete.uid).then(() => {
      return functions.logger.log(
        'Deleted user account',
        userToDelete.uid,
        'because of inactivity'
      );
    }).catch((error) => {
      return functions.logger.error(
        'Deletion of inactive user account',
        userToDelete.uid,
        'failed:',
        error
      );
    });
  } else {
    return null;
  }
}

/**
 * Returns the list of all inactive users.
 */
async function getInactiveUsers(users = [], nextPageToken) {
  const result = await admin.auth().listUsers(1000, nextPageToken);
  // Find users that have not signed in in the last 3 days.
  const inactiveUsers = result.users.filter(
    user => Date.parse(user.metadata.lastRefreshTime || user.metadata.lastSignInTime) < (Date.now() - 3 * 24 * 60 * 60 * 1000));

  // Concat with list of previously found inactive users if there was more than 1000 users.
  users = users.concat(inactiveUsers);

  // If there are more users to fetch we fetch them.
  if (result.pageToken) {
    return getInactiveUsers(users, result.pageToken);
  }

  return users;
}


/**
 * Triggers when the state of a sensor changes.
 * Sends an alert message for S_ALERTING and a notification for other state changes.
 */
exports.I2DSstateChangeNotification = functions.region('us-central1').database.ref('/devices/{devId}/state')
  .onWrite(async (change, context) => {
    const devId = (context.params.devId).replace(/\D/g, '');

    const getTokensPromise = admin.database()
      .ref(`/notificationTokens`).once('value');

    const getDeviceInfoPromise = admin.database()
      .ref(`/devices`).once('value');

    const getDeviceLocPromise = admin.database()
      .ref(`/tag`).once('value');

    let tokensSnapshot, deviceSnapshot, locSnapshot;
    let tokens, levels;
    let devices;
    let loc;

    tokensSnapshot = await Promise.resolve(getTokensPromise);
    deviceSnapshot = await Promise.resolve(getDeviceInfoPromise);
    locSnapshot = await Promise.resolve(getDeviceLocPromise);

    devices = Object.values(deviceSnapshot.val());
    loc = Object.values(locSnapshot.val());
    let loc_keys = Object.keys(locSnapshot.val());

    let hw_string;
    switch (devices[devId].hw) {
      case 136:
        hw_string = 'CPN';
        break;
      case 137:
        hw_string = 'PIRSN';
        break;
      case 138:
        hw_string = 'ACSN';
        break;
      default:
        hw_string = 'Unknown device';
        break;
    }
    let state_string;
    switch (devices[devId].state) {
      case 5:
        state_string = 'been activated';
        break;
      case 6:
        state_string = 'been deactivated';
        break;
      case 202:
        state_string = 'detected a hardware fault';
        break;
      case 224:
        state_string = 'booted and will enter deactivated mode once the sensor is stabilized';
        break;
      default:
        state_string = 'encountered an unknown error';
        break;
    }
    let loc_string;
    loc_string = 'an unknown location';
    loc_keys.forEach((key, index) => {
      if (key == devId)
        loc_string = 'the ' + loc[index];

    });
    const warning_payload_pirsn = {
      notification: {
        title: 'I²DS Messaging Service',
        body: 'WARNING! ' + hw_string + ' (ID ' + devices[devId].self_id + ') in ' + loc_string + ' has detected motion.',
      }
    };
    const warning_payload_acsn = {
      notification: {
        title: 'I²DS Messaging Service',
        body: 'WARNING! ' + hw_string + ' (ID ' + devices[devId].self_id + ') has detected that the door in ' + loc_string + ' has been opened.',
      }
    };
    const info_payload = {
      notification: {
        title: 'I²DS Messaging Service',
        body: '' + hw_string + ' (ID ' + devices[devId].self_id + ') has ' + state_string + '.',
      }
    };
    const warning_end_pirsn_HIGH = {
      notification: {
        title: 'I²DS Messaging Service',
        body: 'The system has encountered a likely intrusion event.',
      }
    };
    const priority = {
      android: {
        priority: 'high',
      }
    };

    // Listing all tokens as an array.
    tokens = Object.keys(tokensSnapshot.val());
    levels = Object.values(tokensSnapshot.val());
    const tokensToRemove = [];
    await Promise.all(tokens.map(async (token, index) => {
      let response = (devices[devId].hw == 137 && devices[devId].state == 5 && devices[devId].trigd > 2) ?
        await admin.messaging().sendToDevice(token, warning_end_pirsn_HIGH, priority) : (devices[devId].state == 204) ?
          ((devices[devId].hw == 137) ?
            await admin.messaging().sendToDevice(token, warning_payload_pirsn, priority)
            : await admin.messaging().sendToDevice(token, warning_payload_acsn, priority))
          : ((levels[index] == 1 || levels[index] == 3) && (devices[devId].hw != 138)) ?
            await admin.messaging().sendToDevice(token, info_payload, priority)
            : null;
      if(response != null){
        const error = response.results[0].error;
        if (error) {
          functions.logger.error(
            'Failure sending notification to',
            token,
            error
          );
          // Cleanup the tokens who are not registered anymore.
          if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
            tokensToRemove.push(tokensSnapshot.ref.child(tokens[index]).remove());
          }
        }
      }
    }));
    return Promise.all(tokensToRemove);
  });

/**
 * Triggers when a new sensor is added to the database.
 * Sends a message to indicate the new device.
 */
exports.I2DSdeviceAddedNotification = functions.region('us-central1').database.ref('/devices/{devId}')
  .onCreate(async (change, context) => {
    const devId = (context.params.devId).replace(/\D/g, '');

    const getTokensPromise = admin.database()
      .ref(`/notificationTokens`).once('value');

    const getDeviceInfoPromise = admin.database()
      .ref(`/devices`).once('value');

    let tokensSnapshot;
    let deviceSnapshot;
    let tokens;
    let devices;

    tokensSnapshot = await Promise.resolve(getTokensPromise);
    deviceSnapshot = await Promise.resolve(getDeviceInfoPromise);

    devices = Object.values(deviceSnapshot.val());

    let hw_string;
    switch (devices[devId].hw) {
      case 136:
        hw_string = 'CPN';
        break;
      case 137:
        hw_string = 'PIRSN';
        break;
      case 138:
        hw_string = 'ACSN';
        break;
      default:
        hw_string = 'Unknown device';
        break;
    }

    const new_payload = {
      notification: {
        title: 'I²DS Messaging Service',
        body: '' + hw_string + ' (ID ' + devices[devId].self_id + ') has joined the system.',
      }
    };
    // Listing all tokens as an array.
    tokens = Object.keys(tokensSnapshot.val());
    // Send notifications to all tokens.
    const response = await admin.messaging().sendToDevice(tokens, new_payload);
    // For each message check if there was an error.
    const tokensToRemove = [];
    response.results.forEach((result, index) => {
      const error = result.error;
      if (error) {
        functions.logger.error(
          'Failure sending notification to',
          tokens[index],
          error
        );
        // Cleanup the tokens who are not registered anymore.
        if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
          tokensToRemove.push(tokensSnapshot.ref.child(tokens[index]).remove());
        }
      }
    });
    return Promise.all(tokensToRemove);
  });

/**
 * Triggers when the cpn info data changes.
 * Sends a message informing the user of either a PR or security failure.
 */
exports.I2DSinfoNotification = functions.region('us-central1').database.ref('/info')
  .onUpdate(async (change, context) => {

    const getTokensPromise = admin.database()
      .ref(`/notificationTokens`).once('value');

    const getInfoPromise = admin.database()
      .ref(`/info`).once('value');

    let tokensSnapshot;
    let infoSnapshot;
    let tokens;
    let levels;

    tokensSnapshot = await Promise.resolve(getTokensPromise);
    infoSnapshot = await Promise.resolve(getInfoPromise);

    let info = Object.values(infoSnapshot.val());
    let payload;
    if (info[2] == 'false') {
      payload = {
        notification: {
          title: 'I²DS Messaging Service',
          body: 'Power failure detected.',
        }
      };
    }
    else if (info[3] == 'false') {
      payload = {
        notification: {
          title: 'I²DS Messaging Service',
          body: 'Security breach detected.',
        }
      };
    }
    else
      return;

    // Listing all tokens as an array.
    tokens = Object.keys(tokensSnapshot.val());
    levels = Object.values(tokensSnapshot.val());
    const tokensToRemove = [];
    await Promise.all(tokens.map(async (token, index) => {
      if (levels[index] == 3 || levels[index] == 2) {
        let response = await admin.messaging().sendToDevice(tokens, payload);
        const error = response.results[0].error;
        if (error) {
          functions.logger.error(
            'Failure sending notification to',
            token,
            error
          );
          // Cleanup the tokens who are not registered anymore.
          if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
            tokensToRemove.push(tokensSnapshot.ref.child(tokens[index]).remove());
          }
        }
      }

    }));
    return Promise.all(tokensToRemove);
  });



