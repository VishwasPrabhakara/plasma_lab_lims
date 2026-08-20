# AWS Online Deployment

Use this setup:

- **Frontend**: GitHub Pages, serving the `public/` folder.
- **Backend**: AWS Elastic Beanstalk, running `server.js`.
- **Database**: AWS RDS PostgreSQL.

GitHub Pages cannot run the backend. It only hosts HTML/CSS/JS.

## 1. Create AWS RDS PostgreSQL

Create an RDS PostgreSQL database and copy its connection string.

It will look like:

```bash
postgresql://USERNAME:PASSWORD@RDS-ENDPOINT:5432/DATABASE_NAME
```

Use that as `DATABASE_URL` in Elastic Beanstalk.

## 2. Deploy Backend To AWS Elastic Beanstalk

The backend is already prepared for Elastic Beanstalk with:

```text
Procfile
```

Elastic Beanstalk should run:

```bash
npm start
```

Upload/deploy the project folder as a Node.js app.

Set these Elastic Beanstalk environment variables:

```bash
DATABASE_URL=postgresql://USERNAME:PASSWORD@RDS-ENDPOINT:5432/DATABASE_NAME
FRONTEND_PUBLIC_URL=https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME
ALLOWED_ORIGINS=https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME
JWT_SECRET=make-this-a-long-random-secret
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-16-digit-gmail-app-password
SMTP_FROM=your-gmail@gmail.com
SMTP_FROM_NAME=Plasma Lab LIMS
```

If RDS SSL causes a connection issue inside your AWS setup, set:

```bash
DATABASE_SSL=false
```

## 3. Configure GitHub Pages Frontend

Edit:

```text
public/config.js
```

Put your AWS backend URL:

```js
window.PLASMA_LIMS_CONFIG = {
  API_BASE: "https://YOUR-AWS-BACKEND-URL"
};
```

Example:

```js
window.PLASMA_LIMS_CONFIG = {
  API_BASE: "https://plasma-lab-lims.ap-south-1.elasticbeanstalk.com"
};
```

Then publish the `public/` folder with GitHub Pages.

## 4. QR Code Fix

Once `FRONTEND_PUBLIC_URL` is set on AWS, newly printed QR labels will contain:

```text
https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME/?sample=PL-2026-000043
```

So a normal phone camera opens the sample page directly.

Old labels printed before this change may still show JSON. Reprint those QR labels after deploying.

## 5. AWS Security Checklist

- Allow Elastic Beanstalk to connect to RDS PostgreSQL.
- Do not expose RDS publicly unless necessary.
- Keep `JWT_SECRET`, `DATABASE_URL`, and Gmail app password only in AWS environment variables.
- Keep `ALLOWED_ORIGINS` restricted to the GitHub Pages URL.
- Use HTTPS backend URL in `public/config.js`.
