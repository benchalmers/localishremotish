We create two applications:
  - remoteish
  - localish
  
Both are node.js aplications and they work together

localish runs on a windows desktop

remoteish runs on a linux system (which is accessed by terminal only)

When I run

remoteish browser <url>

localish opens a browser on the windows desktop

When I run

remoteish explore

localish opens a browser on the windows desktop, and provides a web page the browser connects to
which lets me see the contents of the directory where remotish is opened, I can navigate
that to subdirectories (but not parent directories) and I can open text files and markdown files
in the borwser (I might want to extend this to allow me to open other file types in the future)

Localish should also allow files to be uploaded and downloaded to the remote system via drag and drop

How remoteish connects to localish

rather than using ssh directly, we use the following command

alias ssh-forward='_ssh_fwd() { \
    # 1. Generate the unique socket path
    local UNIQUE_ID="${USER}_$(hostname)_$(date +%s)"; \
    local REMOTE_PATH="/tmp/fwd_${UNIQUE_ID}.sock"; \
    echo "Forwarding to remote socket: $REMOTE_PATH"; \
    \
    # 2. Connect, pass the -R flag, and execute the environment injection
    # -t forces a pseudo-tty allocation so the remote interactive shell works properly.
    ssh -t -R "$SOCK_PATH:localhost:8080" "$1" \
        "export LOCALISH_REMOTE_SOCKET='$REMOTE_PATH'; exec \$SHELL -l"; \
}; _ssh_fwd'

(Ideally we translate that to powershell or cmd.exe and put that into a script)

We run localish as a server which listens on 8080 on the local host
remoteish uses a connection to LOCALISH_REMOTE_SOCKET to connect to localish
