# I<sup>2</sup>DS-FCM

This is a submodule of [I<sup>2</sup>DS](https://github.com/edward62740/i2ds) for sending Firebase Cloud Messages (FCM) to client devices when an appropriate change is detected on Firebase RTDB.

Current trigger events:
* onWrite to any path /devices/{devId}/state, trigger ALERT or state change notification if enabled in device-specific notificationTokens settings.
* onCreate to /devices/{devId}; indicates a new device has joined.
* onUpdate to /info, watches for state changes to security[TBD] or power reserve system.