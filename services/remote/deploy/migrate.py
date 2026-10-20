"""Explicit schema setup/check/export DDL. Does not start Hub or create business databases."""
import argparse
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
from hub_store import HubStore,metadata
from sqlalchemy.schema import CreateTable,CreateIndex
from sqlalchemy.dialects import mysql
parser=argparse.ArgumentParser()
parser.add_argument('action',choices=['migrate','check','ddl'])
args=parser.parse_args()
if args.action=='ddl':
    print('-- Apply only in the dedicated station_hub database, using a migration account. Schema v1.')
    for table in metadata.sorted_tables:
        print(str(CreateTable(table).compile(dialect=mysql.dialect()))+';')
        for index in sorted(table.indexes,key=lambda item:item.name): print(str(CreateIndex(index).compile(dialect=mysql.dialect()))+';')
    print('INSERT INTO hub_schema (id,version) VALUES (1,1);')
else:
    store=HubStore.production()
    store.migrate() if args.action=='migrate' else store.ready()
    print('Hub schema v1 ready')
