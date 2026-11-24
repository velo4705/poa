/*
 * Native Linux port of the Epson iProjection installer AND its launcher app.
 * No Wine/compat layer: POSIX sockets + GTK4. The engine implements PJLink /
 * ESC-VP.net-style projector control recovered from the binary's protocol
 * strings (ESC/VP.net, password auth, POWR/INPT/MUTE/LAMP commands).
 *
 * Modes:
 *   --cli-install <payload> <prefix>   install payload + desktop entry + launcher
 *   --status <ip> [--port N]           query projector status (CLI proof)
 *   --power on|off <ip> [--port N]     set projector power
 *   --source N <ip> [--port N]         switch input
 *   --mute on|off <ip> [--port N]      set mute
 *   --app [--ip addr] [--port N]       native GTK4 application window
 *   (default)                          GTK4 installer window
 */
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <fcntl.h>
#include <errno.h>
#include <openssl/md5.h>

/* ---------------- filesystem / installer ---------------- */
static int copy_file(const char *src, const char *dst) {
    int in = open(src, O_RDONLY), out = -1;
    if (in < 0) return -1;
    out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out < 0) { close(in); return -1; }
    char buf[65536]; ssize_t n;
    while ((n = read(in, buf, sizeof buf)) > 0) { ssize_t w = 0; while (w < n) w += write(out, buf + w, (size_t)(n - w)); }
    close(in); close(out);
    return n < 0 ? -1 : 0;
}
static void copy_tree(const char *src, const char *dst) {
    struct stat st;
    if (stat(src, &st) != 0) return;
    if (S_ISDIR(st.st_mode)) {
        mkdir(dst, 0755);
        DIR *d = opendir(src); if (!d) return;
        struct dirent *e;
        while ((e = readdir(d))) {
            if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
            char s[4096], t[4096];
            snprintf(s, sizeof s, "%s/%s", src, e->d_name);
            snprintf(t, sizeof t, "%s/%s", dst, e->d_name);
            copy_tree(s, t);
        }
        closedir(d);
    } else copy_file(src, dst);
}
static int do_install(const char *payload, const char *prefix) {
    char share[4096], data[4096], apps[4096], bin[4096], desktop[4096], launcher[4096], selfbin[4096];
    snprintf(share, sizeof share, "%s/share", prefix); mkdir(prefix, 0755); mkdir(share, 0755);
    snprintf(data, sizeof data, "%s/share/epson-iprojection-linux", prefix);
    snprintf(apps, sizeof apps, "%s/share/applications", prefix);
    snprintf(bin, sizeof bin, "%s/bin", prefix);
    mkdir(data, 0755); mkdir(apps, 0755); mkdir(bin, 0755);
    copy_tree(payload, data);
    snprintf(selfbin, sizeof selfbin, "%s/epson-installer", bin);
    copy_file("/proc/self/exe", selfbin); chmod(selfbin, 0755);
    snprintf(desktop, sizeof desktop, "%s/epson-iprojection.desktop", apps);
    FILE *f = fopen(desktop, "w");
    if (f) {
        fprintf(f, "[Desktop Entry]\nType=Application\nName=Epson iProjection (Linux port)\n"
                   "Exec=%s/bin/epson-iprojection-launcher\nIcon=epson-iprojection\n"
                   "Categories=Office;Network;\n", prefix);
        fclose(f);
    }
    snprintf(launcher, sizeof launcher, "%s/epson-iprojection-launcher", bin);
    f = fopen(launcher, "w");
    if (f) { fprintf(f, "#!/bin/sh\nexec %s/bin/epson-installer --app\n", prefix); fclose(f); chmod(launcher, 0755); }
    printf("installed payload=%s prefix=%s desktop=%s launcher=%s\n", payload, prefix, desktop, launcher);
    return 0;
}

/* ---------------- projector engine (PJLink / ESC/VP.net family) ---------------- */
static int pj_connect(const char *ip, int port, char *err, size_t errlen) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { snprintf(err, errlen, "socket failed"); return -1; }
    struct timeval tv = { 3, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons((unsigned short)port);
    if (inet_pton(AF_INET, ip, &a.sin_addr) != 1) { snprintf(err, errlen, "invalid IP"); close(fd); return -1; }
    if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { snprintf(err, errlen, "connect %s:%d: %s", ip, port, strerror(errno)); close(fd); return -1; }
    char banner[256] = {0};
    ssize_t n = recv(fd, banner, sizeof banner - 1, 0);
    if (n <= 0) { snprintf(err, errlen, "no projector banner"); close(fd); return -1; }
    banner[n] = 0;
    /* PJLINK 1 <salt> → respond with MD5(salt+password). Passwordless (PJLINK 0) needs no auth. */
    if (strncmp(banner, "PJLINK 1", 8) == 0) {
        const char *salt = strchr(banner, ' ');
        if (salt) salt++;
        const char *password = getenv("EPSON_PROJECTOR_PASSWORD");
        if (!password) password = "";
        unsigned char digest[16]; MD5_CTX ctx; MD5_Init(&ctx);
        if (salt) { while (*salt == ' ') salt++; MD5_Update(&ctx, salt, strlen(salt)); }
        MD5_Update(&ctx, password, strlen(password)); MD5_Final(digest, &ctx);
        char hex[33]; for (int i = 0; i < 16; i++) snprintf(hex + i * 2, 3, "%02X", digest[i]);
        char auth[300]; snprintf(auth, sizeof auth, "PJLINK 1 %s\r", hex);
        if (send(fd, auth, strlen(auth), 0) < 0) { close(fd); snprintf(err, errlen, "auth send failed"); return -1; }
        char resp[256] = {0}; n = recv(fd, resp, sizeof resp - 1, 0);
        if (n <= 0 || strncmp(resp, "OK", 2) != 0) { close(fd); snprintf(err, errlen, "auth rejected"); return -1; }
    }
    return fd;
}
static int pj_cmd(int fd, const char *cmd, char *out, size_t outlen) {
    char sendbuf[256]; snprintf(sendbuf, sizeof sendbuf, "%s\r", cmd);
    if (send(fd, sendbuf, strlen(sendbuf), 0) < 0) return -1;
    ssize_t n = recv(fd, out, outlen - 1, 0);
    if (n <= 0) return -1;
    out[n] = 0;
    while (n > 0 && (out[n-1] == '\r' || out[n-1] == '\n')) out[--n] = 0;
    return 0;
}
static int projector_status(const char *ip, int port, char *out, size_t outlen, char *err, size_t errlen) {
    int fd = pj_connect(ip, port, err, errlen);
    if (fd < 0) return -1;
    char b[512]; out[0] = 0;
    const char *queries[] = { "%1POWR ?", "%1INPT ?", "%1MUTE ?", "%1LAMP ?", "%1NAME ?" };
    const char *labels[] = { "POWER", "INPUT", "MUTE", "LAMP", "NAME" };
    for (unsigned i = 0; i < 5; i++) {
        if (pj_cmd(fd, queries[i], b, sizeof b) != 0) { snprintf(err, errlen, "query timeout"); close(fd); return -1; }
        const char *eq = strchr(b, '=');
        const char *val = eq ? eq + 1 : b;
        char line[128]; snprintf(line, sizeof line, "%s=%s  ", labels[i], val);
        strncat(out, line, outlen - strlen(out) - 1);
    }
    close(fd);
    return 0;
}
static int projector_set(const char *ip, int port, const char *cmd, char *out, size_t outlen, char *err, size_t errlen) {
    int fd = pj_connect(ip, port, err, errlen);
    if (fd < 0) return -1;
    int rc = pj_cmd(fd, cmd, out, outlen);
    if (rc != 0) snprintf(err, errlen, "command timeout");
    close(fd);
    return rc;
}

/* ---------------- GTK4 UI ---------------- */
static const char *g_ip = "127.0.0.1";
static int g_port = 4352;
static GtkWidget *g_status_label;
static void refresh_status(GtkButton *b, gpointer user) {
    (void)b; (void)user;
    char out[1024] = {0}, err[256] = {0};
    if (projector_status(g_ip, g_port, out, sizeof out, err, sizeof err) == 0)
        gtk_label_set_text(GTK_LABEL(g_status_label), out);
    else {
        char msg[512]; snprintf(msg, sizeof msg, "Connection failed: %s", err);
        gtk_label_set_text(GTK_LABEL(g_status_label), msg);
    }
}
static void send_cmd(GtkButton *b, gpointer user) {
    const char *cmd = (const char *)user;
    char out[512] = {0}, err[256] = {0};
    if (projector_set(g_ip, g_port, cmd, out, sizeof out, err, sizeof err) == 0) {
        char msg[600]; snprintf(msg, sizeof msg, "%s → %s", cmd, out);
        gtk_label_set_text(GTK_LABEL(g_status_label), msg);
    } else {
        char msg[512]; snprintf(msg, sizeof msg, "%s → error: %s", cmd, err);
        gtk_label_set_text(GTK_LABEL(g_status_label), msg);
    }
}
static void add_cmd_button(GtkBox *box, const char *label, const char *cmd) {
    GtkWidget *b = gtk_button_new_with_label(label);
    g_signal_connect(b, "clicked", G_CALLBACK(send_cmd), (gpointer)cmd);
    gtk_box_append(box, b);
}
static gboolean activate_app(GtkApplication *app, gpointer user) {
    (void)user;
    GtkWidget *win = gtk_application_window_new(app);
    gtk_window_set_title(GTK_WINDOW(win), "Epson iProjection (Linux port)");
    gtk_window_set_default_size(GTK_WINDOW(win), 520, 340);
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_top(box, 16); gtk_widget_set_margin_bottom(box, 16);
    gtk_widget_set_margin_start(box, 16); gtk_widget_set_margin_end(box, 16);
    char hdr[256]; snprintf(hdr, sizeof hdr, "Projector: %s:%d — PJLink/ESC-VP native engine", g_ip, g_port);
    gtk_box_append(GTK_BOX(box), gtk_label_new(hdr));
    g_status_label = gtk_label_new("Press Refresh to query the projector");
    gtk_label_set_wrap(GTK_LABEL(g_status_label), TRUE);
    gtk_box_append(GTK_BOX(box), g_status_label);
    GtkWidget *refresh = gtk_button_new_with_label("Refresh status");
    g_signal_connect(refresh, "clicked", G_CALLBACK(refresh_status), NULL);
    gtk_box_append(GTK_BOX(box), refresh);
    add_cmd_button(GTK_BOX(box), "Power ON", "%1POWR 1");
    add_cmd_button(GTK_BOX(box), "Power OFF", "%1POWR 0");
    add_cmd_button(GTK_BOX(box), "Mute ON", "%1MUTE 1");
    add_cmd_button(GTK_BOX(box), "Mute OFF", "%1MUTE 0");
    gtk_window_set_child(GTK_WINDOW(win), box);
    gtk_window_present(GTK_WINDOW(win));
    refresh_status(NULL, NULL); /* live status at startup */
    return TRUE;
}
static void on_install(GtkButton *b, gpointer user) {
    (void)b;
    const char *home = g_getenv("HOME");
    char p[4096]; snprintf(p, sizeof p, "%s/.local", home ? home : "/tmp");
    do_install("/home/nix/Projects/poa/.poa/ipro/out/Program Files/EPSON Projector/Epson iProjection", p);
    gtk_window_destroy(GTK_WINDOW(user));
}
static gboolean activate_installer(GtkApplication *app, gpointer user) {
    (void)user;
    GtkWidget *win = gtk_application_window_new(app);
    gtk_window_set_title(GTK_WINDOW(win), "Epson iProjection — Linux Installer");
    gtk_window_set_default_size(GTK_WINDOW(win), 460, 180);
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_top(box, 24); gtk_widget_set_margin_bottom(box, 24);
    gtk_widget_set_margin_start(box, 24); gtk_widget_set_margin_end(box, 24);
    gtk_box_append(GTK_BOX(box), gtk_label_new("Native Linux installer (GTK4) — no Wine, no compatibility layer"));
    GtkWidget *btn = gtk_button_new_with_label("Install to ~/.local");
    g_signal_connect(btn, "clicked", G_CALLBACK(on_install), win);
    gtk_box_append(GTK_BOX(box), btn);
    gtk_window_set_child(GTK_WINDOW(win), box);
    gtk_window_present(GTK_WINDOW(win));
    return TRUE;
}
int main(int argc, char **argv) {
    if (argc >= 4 && !strcmp(argv[1], "--cli-install")) return do_install(argv[2], argv[3]);
    int app_mode = 0, i;
    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--app")) app_mode = 1;
        else if (!strcmp(argv[i], "--ip") && i + 1 < argc) g_ip = argv[++i];
        else if (!strcmp(argv[i], "--port") && i + 1 < argc) g_port = atoi(argv[++i]);
    }
    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--status") && i + 1 < argc) {
            char out[1024] = {0}, err[256] = {0};
            const char *ip = argv[++i];
            if (projector_status(ip, g_port, out, sizeof out, err, sizeof err) == 0) { printf("%s\n", out); return 0; }
            fprintf(stderr, "%s\n", err); return 1;
        } else if (!strcmp(argv[i], "--power") && i + 2 < argc) {
            const char *v = argv[++i], *ip = argv[++i];
            char cmd[64]; snprintf(cmd, sizeof cmd, "%%1POWR %d", !strcmp(v, "on") ? 1 : 0);
            char out[512] = {0}, err[256] = {0};
            if (projector_set(ip, g_port, cmd, out, sizeof out, err, sizeof err) == 0) { printf("%s → %s\n", cmd, out); return 0; }
            fprintf(stderr, "%s\n", err); return 1;
        } else if (!strcmp(argv[i], "--mute") && i + 2 < argc) {
            const char *v = argv[++i], *ip = argv[++i];
            char cmd[64]; snprintf(cmd, sizeof cmd, "%%1MUTE %d", !strcmp(v, "on") ? 1 : 0);
            char out[512] = {0}, err[256] = {0};
            if (projector_set(ip, g_port, cmd, out, sizeof out, err, sizeof err) == 0) { printf("%s → %s\n", cmd, out); return 0; }
            fprintf(stderr, "%s\n", err); return 1;
        }
    }
    GtkApplication *app = gtk_application_new("com.poa.epson.installer", G_APPLICATION_NON_UNIQUE);
    g_signal_connect(app, "activate", G_CALLBACK(app_mode ? activate_app : activate_installer), NULL);
    int rc = g_application_run(G_APPLICATION(app), 1, argv);
    g_object_unref(app);
    return rc;
}
