# Alertmanager secrets

Runtime secrets for Alertmanager receivers. Only `.keep` and this
README are tracked in git — every other file in this directory is
excluded via `.gitignore` and MUST live only on the deployed hosts.

## Files expected here

### `smtp_password`

Raw SMTP password for `systemalerts@onfonmedia.co.tz`, one line, **no
trailing newline**. Alertmanager reads it via
`smtp_auth_password_file: /etc/alertmanager/secrets/smtp_password`
(see `../alertmanager.yml`).

Create it on the deployed host with the password ops holds:

```bash
umask 077
printf '%s' 'THE_PASSWORD_HERE' > /path/to/repo/monitoring/alertmanager/secrets/smtp_password
chmod 600 /path/to/repo/monitoring/alertmanager/secrets/smtp_password
```

`printf` (not `echo`) is important — `echo` appends a newline which
mail.onfonmedia.co.tz will refuse.

## Adding future secrets

Same pattern: one file per credential, `chmod 600`, mount is
already in place (`monitoring/alertmanager/secrets:/etc/alertmanager/secrets:ro`).
Reference from `alertmanager.yml` via `*_file:` fields — never inline
the value into the YAML.
