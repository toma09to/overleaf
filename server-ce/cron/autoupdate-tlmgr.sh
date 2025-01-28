#!/usr/bin/env bash

set -eux

echo "------------------"
echo "Autoupdating tlmgr"
echo "------------------"
date

tlmgr update --self --all
