const GITHUB_API = "https://api.github.com";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.GITHUB_PAT}`,
    "Content-Type": "application/json",
    "User-Agent": "events-wageningen-bot/1.0",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Upload (or overwrite) a JPEG image to public/images/{eventId}.jpg in the website repo. */
export async function uploadImage(
  eventId: string,
  imageBase64: string
): Promise<void> {
  const owner = process.env.GITHUB_OWNER!;
  const repo = process.env.GITHUB_REPO!;
  const path = `public/images/${eventId}.jpg`;

  // Fetch existing file SHA (required when updating an existing file)
  const checkRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    { headers: headers() }
  );

  const body: Record<string, string> = {
    message: `images: add photo for ${eventId}`,
    content: imageBase64,
  };

  if (checkRes.ok) {
    const existing = (await checkRes.json()) as { sha: string };
    body.sha = existing.sha;
  }

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    { method: "PUT", headers: headers(), body: JSON.stringify(body) }
  );

  if (!res.ok) {
    throw new Error(`GitHub image upload failed (${res.status}): ${await res.text()}`);
  }
}

/** Trigger the production deploy workflow via workflow_dispatch. */
export async function triggerDeploy(): Promise<void> {
  const owner = process.env.GITHUB_OWNER!;
  const repo = process.env.GITHUB_REPO!;

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/deploy.yml/dispatches`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ref: "main" }),
    }
  );

  if (!res.ok) {
    throw new Error(`Deploy trigger failed (${res.status}): ${await res.text()}`);
  }
}
