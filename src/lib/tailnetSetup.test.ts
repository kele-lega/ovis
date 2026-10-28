import { describe, expect, it } from "bun:test";
import { sshSetupFailure, tailnetDestination } from "./tailnetSetup.ts";

describe("tailnetDestination", () => {
  it("requires an explicit account instead of falling back to the server's username", () => {
    for (const user of ["", " ", "root@other-host", "-oProxyCommand=x", "DOMAIN\\user", "alice smith", "alice\nwhoami", "alice;id"]) {
      expect(tailnetDestination(user, "100.100.49.92")).toBeNull();
    }
    expect(tailnetDestination("a".repeat(129), "100.100.49.92")).toBeNull();
  });

  it("combines the selected IP with the account without changing the address", () => {
    expect(tailnetDestination("alice", "100.100.49.92")).toBe("alice@100.100.49.92");
    expect(tailnetDestination("build.user-1", "fd7a:115c:a1e0::315e")).toBe("build.user-1@fd7a:115c:a1e0::315e");
    expect(tailnetDestination("_service", "100.64.0.2")).toBe("_service@100.64.0.2");
  });
});

describe("sshSetupFailure", () => {
  it("recognizes SSH transport, authentication and DNS failures", () => {
    expect(sshSetupFailure("ssh: connect to host 100.100.49.92 port 22: Connection refused")).toBe("refused");
    expect(sshSetupFailure("ssh: connect to host 100.100.49.92 port 22: Connection timed out")).toBe("timeout");
    expect(sshSetupFailure("SSH connection timed out")).toBe("timeout");
    expect(sshSetupFailure("alice@100.100.49.92: Permission denied (publickey,password).")).toBe("authentication");
    expect(sshSetupFailure("Received disconnect: Too many authentication failures")).toBe("authentication");
    expect(sshSetupFailure("ssh: Could not resolve hostname 1024.tailb3056e.ts.net: Name or service not known")).toBe("dns");
    expect(sshSetupFailure("ssh: Could not resolve hostname old-name: nodename nor servname provided, or not known")).toBe("dns");
  });

  it("does not call a local file permission, bridge failure or host-key problem a bad password", () => {
    for (const words of ["Identity file /keys/key not accessible: Permission denied.", "EACCES: permission denied, open /state/machines.json", "Host key verification failed.", "REMOTE HOST IDENTIFICATION HAS CHANGED!", "Bridge process verification failed", "", "SSH connection ended"]) {
      expect(sshSetupFailure(words)).toBeNull();
    }
  });
});
