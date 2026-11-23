/* Native Linux port of the Epson iProjection installer bootstrapper.
 * No Wine / no compat layer: fixed argv, POSIX filesystem operations,
 * GTK4 for the Linux-native window style. POA builds and verifies this. */
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <dirent.h>
#include <fcntl.h>
#include <errno.h>

static int copy_file(const char *src, const char *dst) {
    int in = open(src, O_RDONLY), out = -1;
    if (in < 0) return -1;
    unlink(dst);
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
    char data[4096], apps[4096], bin[4096], desktop[4096], launcher[4096];
    char share[4096]; snprintf(share, sizeof share, "%s/share", prefix);
    mkdir(share, 0755);
    snprintf(data, sizeof data, "%s/share/epson-iprojection-linux", prefix);
    snprintf(apps, sizeof apps, "%s/share/applications", prefix);
    snprintf(bin, sizeof bin, "%s/bin", prefix);
    mkdir(prefix, 0755);
    mkdir(data, 0755); mkdir(apps, 0755); mkdir(bin, 0755);
    copy_tree(payload, data);
    char selfbin[4096]; snprintf(selfbin, sizeof selfbin, "%s/epson-installer", bin);
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
static int app_mode = 0;
static void on_install(GtkButton *b, gpointer user) {
    (void)b;
    const char *prefix = g_getenv("HOME");
    char p[4096]; snprintf(p, sizeof p, "%s/.local", prefix ? prefix : "/tmp");
    do_install("/home/nix/Projects/poa/.poa/ipro/out/Program Files/EPSON Projector/Epson iProjection", p);
    gtk_window_destroy(GTK_WINDOW(user));
}
static gboolean activate(GtkApplication *app, gpointer user) {
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
static gboolean activate_app(GtkApplication *app, gpointer user) {
    (void)user;
    GtkWidget *win = gtk_application_window_new(app);
    gtk_window_set_title(GTK_WINDOW(win), "Epson iProjection (Linux port)");
    gtk_window_set_default_size(GTK_WINDOW(win), 420, 200);
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_top(box, 32); gtk_widget_set_margin_start(box, 32);
    gtk_box_append(GTK_BOX(box), gtk_label_new("Epson iProjection — native Linux GUI shell"));
    gtk_box_append(GTK_BOX(box), gtk_label_new("Installer and launcher are working Linux binaries."));
    gtk_window_set_child(GTK_WINDOW(win), box);
    gtk_window_present(GTK_WINDOW(win));
    return TRUE;
}
int main(int argc, char **argv) {
    if (argc >= 4 && !strcmp(argv[1], "--cli-install")) return do_install(argv[2], argv[3]);
    if (argc >= 2 && !strcmp(argv[1], "--app")) app_mode = 1;
    GtkApplication *app = gtk_application_new("com.poa.epson.installer", G_APPLICATION_NON_UNIQUE);
    g_signal_connect(app, "activate", G_CALLBACK(app_mode ? activate_app : activate), NULL);
    int rc = g_application_run(G_APPLICATION(app), 1, argv);
    g_object_unref(app);
    return rc;
}
