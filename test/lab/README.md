# The lab

A real copy of the backend on an embedded Postgres, for checks that need a running server (not part of `npm test`):

    node test/lab/lab.js                 # starts it, writes lab.json (port, app id, tokens), stays up
    node test/lab/tenant.check.js        # cross-business isolation: 22 checks
    node test/lab/load.check.js          # booking races and request bursts with latency percentiles

Nothing here touches a real database or service (Firebase and Cloudinary are stand-ins). `lab.json` is a throw-away file; do not commit it.
