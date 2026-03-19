# Security

## Exposed Secrets Incident

**render-environment-variables.csv** previously contained real credentials and was committed to Git. It has been:

1. **Removed from Git tracking** (file is now in `.gitignore`)
2. **Replaced** by `render-environment-variables.example.csv` with placeholders

## Required Actions (Do These Now)

### 1. Rotate All Exposed Credentials

Since the credentials were in Git history, **rotate them immediately**:

| Service | Action |
|---------|--------|
| **Cloudinary** | [Dashboard](https://console.cloudinary.com/) → Settings → Security → Regenerate API key / secret |
| **MongoDB Atlas** | Database Access → Edit user → Edit Password (new password) |
| **JWT** | Generate a new secret; update in `.env` and Render |
| **Render** | Update all env vars in Dashboard with the new values |

### 2. Remove Secrets from Git History (Recommended)

The credentials may still exist in old commits. To remove them:

```bash
# Option A: BFG Repo-Cleaner (recommended)
# 1. Install: brew install bfg
# 2. Clone a fresh copy: git clone --mirror <repo-url>
# 3. Run: bfg --delete-files render-environment-variables.csv
# 4. cd repo.git && git reflog expire --expire=now --all && git gc
# 5. git push --force

# Option B: git filter-repo (if history rewrite is critical)
# See: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository
```

### 3. Set Environment Variables on Render

Use **Render Dashboard** → Your Service → Environment to add variables. Do **not** commit CSV files with real values.

## Going Forward

- Never commit `.env`, `render-environment-variables.csv`, or any file with real credentials
- Use `.env.example` and `*.example.csv` for documentation only
- Store production secrets in Render Dashboard, Cloudinary Dashboard, MongoDB Atlas
