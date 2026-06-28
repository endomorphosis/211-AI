#!/bin/sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SUBMODULE_PATH="$REPO_ROOT/ipfs_datasets_py"
PACKAGE_PATH="$SUBMODULE_PATH/ipfs_datasets_py"

cd "$REPO_ROOT"

python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt

if [ ! -d "$PACKAGE_PATH" ]; then
    echo "ipfs_datasets_py checkout is missing; initializing the git submodule." >&2
    git submodule update --init --recursive ipfs_datasets_py
fi

if [ ! -d "$PACKAGE_PATH" ]; then
    echo "ipfs_datasets_py checkout is still missing. Populate the submodule before installing wallet proof/storage dependencies." >&2
    exit 1
fi

python3 -m pip install -e "$SUBMODULE_PATH"

echo "Installed wallet API dependencies plus ipfs_datasets_py for proofs and IPFS/Filecoin storage integrations."