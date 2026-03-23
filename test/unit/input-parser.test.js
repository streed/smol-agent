/**
 * Tests for input parser - @file mentions and image attachments
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseInput, buildUserContent } from "../../src/input-parser.js";

describe("input-parser", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "input-parser-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("parseInput", () => {
    test("returns unchanged text when no @mentions", async () => {
      const result = await parseInput("Hello world", tmpDir);
      expect(result.text).toBe("Hello world");
      expect(result.files).toEqual([]);
      expect(result.images).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    test("loads text file content", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "line1\nline2\nline3");

      const result = await parseInput(`Check @test.txt please`, tmpDir);

      expect(result.text).toBe("Check please");
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("test.txt");
      expect(result.files[0].content).toContain("1\tline1");
      expect(result.files[0].content).toContain("2\tline2");
      expect(result.files[0].content).toContain("3\tline3");
      expect(result.images).toEqual([]);
    });

    test("handles multiple @mentions", async () => {
      await fs.writeFile(path.join(tmpDir, "a.txt"), "file A");
      await fs.writeFile(path.join(tmpDir, "b.txt"), "file B");

      const result = await parseInput("See @a.txt and @b.txt", tmpDir);

      expect(result.files).toHaveLength(2);
      expect(result.files.map(f => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    });

    test("rejects paths outside jail directory", async () => {
      // Use a path with an extension so the regex matches
      const result = await parseInput("Read @/etc/passwd.txt", tmpDir);

      expect(result.files).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("outside jail");
    });

    test("handles non-existent files gracefully", async () => {
      const result = await parseInput("Check @missing.txt", tmpDir);

      expect(result.files).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("not found");
    });

    test("detects image files and encodes as base64", async () => {
      const imgPath = path.join(tmpDir, "photo.png");
      const imgData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      await fs.writeFile(imgPath, imgData);

      const result = await parseInput("Look at @photo.png", tmpDir);

      expect(result.text).toBe("Look at [image: photo.png]");
      expect(result.files).toEqual([]);
      expect(result.images).toHaveLength(1);
      expect(result.images[0].path).toBe("photo.png");
      expect(result.images[0].mimeType).toBe("image/png");
      expect(result.images[0].base64).toBe("iVBORw==");
    });

    test("detects jpg images with correct mime type", async () => {
      const imgPath = path.join(tmpDir, "pic.jpg");
      await fs.writeFile(imgPath, Buffer.from([0xff, 0xd8, 0xff]));

      const result = await parseInput("@pic.jpg", tmpDir);

      expect(result.images).toHaveLength(1);
      expect(result.images[0].mimeType).toBe("image/jpeg");
    });

    test("rejects binary files", async () => {
      const binPath = path.join(tmpDir, "data.bin");
      await fs.writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0x00]));

      const result = await parseInput("Read @data.bin", tmpDir);

      expect(result.files).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("Binary");
    });

    test("rejects files larger than maxFileSize", async () => {
      const bigPath = path.join(tmpDir, "big.txt");
      await fs.writeFile(bigPath, "x".repeat(1000));

      const result = await parseInput("@big.txt", tmpDir, { maxFileSize: 100 });

      expect(result.files).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("too large");
    });

    test("handles subdirectory paths", async () => {
      await fs.mkdir(path.join(tmpDir, "sub"));
      await fs.writeFile(path.join(tmpDir, "sub", "file.txt"), "nested content");

      const result = await parseInput("@sub/file.txt", tmpDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("sub/file.txt");
    });
  });

  describe("buildUserContent", () => {
    test("returns simple string when no files or images", () => {
      const content = buildUserContent("Hello", [], []);
      expect(content).toBe("Hello");
    });

    test("appends file contents to text", () => {
      const files = [
        { path: "a.txt", content: "1\tline1\n2\tline2" },
        { path: "b.py", content: "1\tprint('hi')" },
      ];

      const content = buildUserContent("Check files", files, []);

      expect(content).toContain("Check files");
      expect(content).toContain("### a.txt");
      expect(content).toContain("### b.py");
      expect(content).toContain("[Attached files]");
    });

    test("returns multi-part content array when images present", () => {
      const images = [
        { path: "img.png", base64: "abc123", mimeType: "image/png" },
      ];

      const content = buildUserContent("See image", [], images);

      expect(Array.isArray(content)).toBe(true);
      expect(content[0]).toEqual({ type: "text", text: expect.stringContaining("See image") });
      expect(content[1]).toEqual({
        type: "image",
        source: { base64: "abc123", mimeType: "image/png" },
      });
    });

    test("includes both files and images in multi-part content", () => {
      const files = [{ path: "doc.txt", content: "1\tcontent" }];
      const images = [{ path: "img.jpg", base64: "xyz", mimeType: "image/jpeg" }];

      const content = buildUserContent("Check this", files, images);

      expect(Array.isArray(content)).toBe(true);
      expect(content[0].type).toBe("text");
      expect(content[0].text).toContain("doc.txt");
      expect(content[1].type).toBe("image");
    });
  });
});