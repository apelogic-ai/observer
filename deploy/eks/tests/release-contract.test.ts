import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const imageWorkflow = readFileSync(resolve(root, ".github/workflows/image.yml"), "utf8");
const chartWorkflow = readFileSync(resolve(root, ".github/workflows/chart.yml"), "utf8");
const chartMetadata = readFileSync(resolve(root, "deploy/eks/chart/Chart.yaml"), "utf8");
const imageDockerfile = readFileSync(resolve(root, "packages/api/Dockerfile"), "utf8");

async function helmTemplate(...args: string[]) {
  const process = Bun.spawn(
    ["helm", "template", "release-contract", "deploy/eks/chart", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );

  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

describe("Observer ECR release workflows", () => {
  test("the runtime image installs only API production dependencies", () => {
    expect(imageDockerfile).toContain(
      "bun install --frozen-lockfile --production --filter @observer/api",
    );
  });

  test("the v* image release uses only configured ECR coordinates and its publisher role", () => {
    expect(imageWorkflow).toContain("vars.AWS_REGION");
    expect(imageWorkflow).toContain("vars.ECR_REGISTRY");
    expect(imageWorkflow).toContain("vars.OBSERVER_IMAGE_ECR_REPOSITORY");
    expect(imageWorkflow).toContain("vars.OBSERVER_IMAGE_PUBLISH_ROLE_ARN");
    expect(imageWorkflow).toContain("aws-actions/configure-aws-credentials@");
    expect(imageWorkflow).toContain("aws-actions/amazon-ecr-login@");
    expect(imageWorkflow).toContain("platforms: linux/amd64");
    expect(imageWorkflow).not.toContain("linux/amd64,linux/arm64");
    expect(imageWorkflow).not.toContain("ghcr.io");
    expect(imageWorkflow).not.toMatch(/:\s*latest\b/);
  });

  test("the image release signs, attests, verifies, scans, and reports its immutable digest", () => {
    expect(imageWorkflow).toContain('SUBJECT="$IMAGE@$IMAGE_DIGEST"');
    expect(imageWorkflow).toContain('cosign sign "$SUBJECT"');
    expect(imageWorkflow).toContain("cosign attest");
    expect(imageWorkflow).toContain("cosign verify-attestation");
    expect(imageWorkflow).toContain("cosign verify");
    expect(imageWorkflow).toContain("sbom.cdx.json");
    expect(imageWorkflow).toContain("provenance.json");
    expect(imageWorkflow).toContain("vulnerability-results.json");
    expect(imageWorkflow).toContain("describe-image-scan-findings");
    expect(imageWorkflow).toContain("CRITICAL");
    expect(imageWorkflow).toContain("release-report.md");
    expect(imageWorkflow).toContain("Image digest");
  });

  test("the chart-v* release uses the separate chart publisher role and exact ECR repository", () => {
    expect(chartWorkflow).toContain('"chart-v*"');
    expect(chartWorkflow).toContain("vars.AWS_REGION");
    expect(chartWorkflow).toContain("vars.ECR_REGISTRY");
    expect(chartWorkflow).toContain("vars.OBSERVER_CHART_ECR_REPOSITORY");
    expect(chartWorkflow).toContain("vars.OBSERVER_CHART_PUBLISH_ROLE_ARN");
    expect(chartWorkflow).toContain("aws-actions/configure-aws-credentials@");
    expect(chartWorkflow).toContain("aws-actions/amazon-ecr-login@");
    expect(chartWorkflow).not.toContain("ghcr.io");
    expect(chartMetadata).toMatch(/^name: observer$/m);
  });

  test("the packaged chart pins appVersion and has verified digest-bound supply-chain evidence", () => {
    expect(chartWorkflow).toContain('--app-version "$VERSION"');
    expect(chartWorkflow).toContain('SUBJECT="$CHART_REF@$CHART_DIGEST"');
    expect(chartWorkflow).toContain('cosign sign "$SUBJECT"');
    expect(chartWorkflow).toContain("cosign attest");
    expect(chartWorkflow).toContain("cosign verify-attestation");
    expect(chartWorkflow).toContain("cosign verify");
    expect(chartWorkflow).toContain("chart-sbom.cdx.json");
    expect(chartWorkflow).toContain("chart-provenance.json");
    expect(chartWorkflow).toContain("chart-vulnerability-results.json");
    expect(chartWorkflow).toContain("release-report.md");
    expect(chartWorkflow).toContain("Chart digest");
  });
});

describe("Observer EKS chart release contract", () => {
  test("renders the required EKS integration path", async () => {
    const rendered = await helmTemplate("-f", "deploy/eks/chart/ci/test-values.yaml");
    expect(rendered.exitCode, rendered.stderr).toBe(0);

    expect(rendered.stdout).toMatch(/kind: Deployment[\s\S]*name: observer-ingestor/);
    expect(rendered.stdout).toMatch(/kind: ExternalSecret/);
    expect(rendered.stdout).toMatch(/eks\.amazonaws\.com\/role-arn:/);
    expect(rendered.stdout).toMatch(/name: OBSERVER_STORAGE\s+value: "s3"/);
    expect(rendered.stdout).toMatch(/name: OBSERVER_S3_BUCKET\s+value: /);
    expect(rendered.stdout).toMatch(/kind: Ingress[\s\S]*ingressClassName: alb/);
    expect(rendered.stdout).toMatch(/kind: NetworkPolicy[\s\S]*ingress:\s+- from:/);
  });

  test("fails closed when required deployment values are absent", async () => {
    const rendered = await helmTemplate();
    expect(rendered.exitCode).not.toBe(0);
    expect(rendered.stderr).toContain("image.repository is required");
  });
});
