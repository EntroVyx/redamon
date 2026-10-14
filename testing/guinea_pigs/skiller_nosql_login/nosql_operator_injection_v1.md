# NoSQL Operator Injection (MongoDB)

Find and exploit MongoDB operator injection in application logins and query
endpoints, where attacker-controlled input reaches a `find` / `findOne` filter
and lets you replace a value with a query operator (`$ne`, `$gt`, `$regex`,
`$in`) to defeat authentication or read data you should not see.

Work measurement-first: prove each step against the live target before escalating.

## Phase: informational

1. Map the login and any search/filter endpoints. For each form, note the field
   names (`username`, `password`, email, id) and the exact URL it posts to.
2. Confirm the normal responses so you have a baseline oracle: a valid login (a
   "welcome"/dashboard page or a 302), and a wrong password (an "invalid
   credentials" page). The difference between these two responses is your
   true/false oracle for everything below.
3. Identify the stack. A Node/Express + MongoDB app is the classic target; an
   `X-Powered-By: Express` header or a Mongo-style error is a strong hint.

## Phase: exploitation

### Step 1 - Authentication bypass with a `$ne` operator

Send the login with the password replaced by a "not equal" operator so the
filter matches any user. Send the body as JSON with `Content-Type:
application/json`:

```
execute_curl: POST /login
  Header: Content-Type: application/json
  Body: {"username":"admin","password":{"$ne":null}}
```

If the response flips from the wrong-password baseline to the welcome/dashboard
state, the login is injectable and you are now authenticated as whichever user
the filter matched first. Try `{"$ne":""}`, `{"$gt":""}`, and
`{"$ne":"wrongvalue"}` as variants.

### Step 2 - Target a specific account

Pin the username to the account you want and keep the operator on the password:

```
{"username":"admin","password":{"$ne":"x"}}
```

### Step 3 - Blind extraction of a secret with `$regex`

When the objective is the value of a field (a password, a token), extract it one
character at a time with a `$regex` anchored at the start. Each request that
returns the welcome state confirms the prefix so far:

```
{"username":"admin","password":{"$regex":"^A"}}
{"username":"admin","password":{"$regex":"^Ab"}}
...
```

Walk the alphabet/digits for each position, append the character that returns the
welcome state, and continue until the whole value is recovered. Build the bodies
with `execute_code` so the quoting survives exactly.

## Abandonment gate

Do not declare the endpoint "not injectable" until you have tried `$ne`, `$gt`
and a `$regex` probe against the password field of at least one known-valid
username, and read the response body of each (not just the status code).

## Reporting

Report the injectable endpoint and field, the operator that worked, the account
reached, and any secret extracted, plus a remediation note (validate/cast input
types server-side; reject objects where a scalar is expected).
