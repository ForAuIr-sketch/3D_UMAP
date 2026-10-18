suppressPackageStartupMessages(library(Seurat));suppressPackageStartupMessages(library(Matrix));library(jsonlite)
args<-commandArgs(trailingOnly=TRUE)
if(length(args)!=3)stop('Usage: Rscript tools/export_review.R source.rds original_viewer_directory output_directory')
source_file <- args[1]
viewer_dir <- args[2]
root <- args[3];dir.create(file.path(root,'data/genes'),recursive=TRUE,showWarnings=FALSE)
ref <- read.csv(file.path(viewer_dir,'data/umap3d_celltype.csv'),check.names=FALSE)
oldfile <- file.path(viewer_dir,'data/umap3d_multifeature.csv')
h <- names(read.csv(oldfile,nrows=0,check.names=FALSE));non_genes<-c('cell_id','UMAP3D_1','UMAP3D_2','UMAP3D_3','CellMajortype','Age_group','ECM_AUC','SenCID_score','SenCID_binary')
ecm <- setdiff(h,non_genes)
panels <- list(
 'Keratinocytes'=c('KRT1','KRT5','KRT10','KRT14','KRT15','KRT6A','KRT6B','KRT16','KRT17','KRT19','EPCAM','TP63','KRTDAP','FLG','LOR','IVL','DSG1','DSG3','COL17A1'),
 'Fibroblasts'=c('DCN','LUM','COL1A1','COL1A2','COL3A1','DPT','PDGFRA','COL6A1','COL6A2','COL6A3','COL14A1','COL15A1','SFRP2','PI16','FAP','POSTN','PRRX1','PDPN'),
 'Vascular endothelial'=c('PECAM1','VWF','CDH5','CLDN5','KDR','FLT1','EMCN','ENG','ESAM','RAMP2','PLVAP','ACKR1','SELE','SELP','EGFL7','CLEC14A'),
 'Lymphatic endothelial'=c('CCL21','PROX1','LYVE1','PDPN','FLT4','TFF3','FOXC2','GJA4'),
 'Pericytes and smooth muscle'=c('RGS5','PDGFRB','CSPG4','ABCC9','KCNJ8','MCAM','NOTCH3','ACTA2','TAGLN','MYH11','MYL9','DES','RBP1','CALD1'),
 'Myeloid'=c('CD68','CD14','LYZ','LST1','AIF1','TYROBP','FCER1G','CSF1R','ITGAM','FCGR3A','CD163','MRC1','C1QA','C1QB','C1QC','S100A8','S100A9','FCN1','CD74','HLA-DRA','HLA-DPA1','HLA-DPB1','CD1C','FCER1A','CLEC10A','ITGAX','CLEC9A','XCR1','LILRA4','GZMB'),
 'T and NK cells'=c('CD3D','CD3E','CD3G','TRAC','TRBC1','TRBC2','CD247','CD2','CD4','CD8A','CD8B','IL7R','CCR7','LTB','TCF7','FOXP3','IL2RA','CTLA4','PDCD1','NKG7','GNLY','PRF1','GZMA','GZMB','KLRD1'),
 'Mast cells'=c('KIT','TPSAB1','TPSB2','CPA3','MS4A2','HDC','FCER1A','GATA2','CTSG','SLC18A2','IL1RL1'),
 'Melanocytes (annotation check)'=c('PMEL','MLANA','TYR','TYRP1','DCT','MITF','SOX10','TRPM1'),
 'B and plasma cells'=c('CD79A','CD79B','MS4A1','CD19','CD37','CD22','MZB1','JCHAIN','SDC1'),
 'Schwann cells'=c('S100B','PLP1','MPZ','SOX10','S100A1','MBP'),
 'ECM panel'=ecm,
 'Senescence and proliferation'=c('CDKN1A','CDKN2A','TP53','LMNB1','MKI67','TOP2A','PCNA','IL6','CXCL8','MMP1','MMP3','MMP9','SERPINE1','GLB1','BMP1'))
required <- c('PECAM1','CCL21','CD3D','CD3E','CD68','CD14','KRT1','KRT5','KRT10','KRT15','EPCAM','DCN','COL1A1','BMP1','ACTA2','KIT')
x<-readRDS(source_file);m<-LayerData(x,assay='RNA',layer='data');meta<-x[[]]
stopifnot(!anyDuplicated(ref$cell_id),setequal(ref$cell_id,colnames(x)));meta<-meta[ref$cell_id,,drop=FALSE]
stopifnot(identical(as.character(meta$CellMajortype),ref$CellMajortype))
embs<-Reductions(x);print(embs)
coords<-ref[,c('UMAP3D_1','UMAP3D_2','UMAP3D_3')]
coord_match<-FALSE
for (red in embs) { e<-Embeddings(x,red);if(ncol(e)>=3) {if(isTRUE(all.equal(unname(as.matrix(coords)),unname(e[ref$cell_id,1:3]),tolerance=1e-10))) {coord_match<-TRUE;cat('Matching embedding',red,'\n')} } }
stopifnot(coord_match)
selected<-unique(c(required,unlist(panels,use.names=FALSE)));present<-intersect(selected,rownames(m));missing<-setdiff(selected,present)
stopifnot(all(required %in% present))
# Retain all metadata without renaming, plus the existing viewer's derived scores.
base<-data.frame(cell_id=ref$cell_id,coords,meta,check.names=FALSE)
keep<-c('cell_id','Age_group','ECM_AUC','SenCID_score','SenCID_binary')
cl<-rep('NULL',length(h));cl[h %in% keep]<-'character'
legacy<-read.csv(oldfile,colClasses=cl,check.names=FALSE);legacy<-legacy[match(ref$cell_id,legacy$cell_id),]
stopifnot(identical(legacy$cell_id,ref$cell_id))
for(f in setdiff(keep,c('cell_id',names(base))))base[[f]]<-legacy[[f]]
write.csv(base,file.path(root,'data/cells_metadata.csv'),row.names=FALSE,na='')
write.csv(data.frame(cell_id=ref$cell_id,meta,check.names=FALSE),file.path(root,'data/metadata_all.csv'),row.names=FALSE,na='')
metadata<-lapply(names(meta),function(f){v<-meta[[f]];list(name=f,type=if(is.numeric(v))'numeric' else 'categorical',r_class=class(v),unique_count=length(unique(v[!is.na(v)])),missing_count=sum(is.na(v)),levels=if(is.factor(v))levels(v) else NULL)})
rows<-match(present,rownames(m));cells<-match(ref$cell_id,colnames(m));gene_manifest<-list()
for(i in seq_along(present)) {
 g<-present[i];v<-as.numeric(m[rows[i],cells]);stopifnot(length(v)==nrow(base),all(is.finite(v)),all(v>=0))
 filename<-sprintf('g%04d.f32',i);con<-file(file.path(root,'data/genes',filename),'wb');writeBin(v,con,size=4,endian='little');close(con)
 gene_manifest[[g]]<-list(file=paste0('data/genes/',filename),min=min(v),max=max(v),q02=unname(quantile(v,.02,type=1)),q98=unname(quantile(v,.98,type=1)),zero_count=sum(v==0),positive_count=sum(v>0),sha256=digest::digest(file=file.path(root,'data/genes',filename),algo='sha256'))
}
panels<-lapply(panels,function(g)intersect(g,present))
manifest<-list(version=1,cells=nrow(base),genes=gene_manifest,panels=panels,metadata=metadata,required_genes=required,missing_requested_panel_genes=missing,source=list(file=basename(source_file),source_bytes=file.info(source_file)$size,metadata_sha256=digest::digest(file=file.path(root,'data/metadata_all.csv'),algo='sha256'),assay='RNA',layer='data',expression='Seurat RNA data layer, exported without re-normalization',encoding='Float32 little-endian',cell_order='cells_metadata.csv cell_id',coordinates='original 3D embedding; matched to viewer CSV',annotation='original CellMajortype; not re-annotated',legacy_scores='ECM_AUC, SenCID_score, SenCID_binary and Age_group retained from existing multifeature CSV; not recalculated',annotation_note='Original Mast cells annotation requires review: high melanocyte-marker expression and low mast-cell-marker detection.'))
write_json(manifest,file.path(root,'data/manifest.json'),auto_unbox=TRUE,pretty=TRUE,na='null',null='null')
write.csv(data.frame(Gene=selected,Available=selected %in% present,Required=selected %in% required),file.path(root,'data/gene_inventory.csv'),row.names=FALSE)
cat('EXPORTED',nrow(base),'cells;',length(metadata),'metadata fields;',length(present),'genes; missing:',paste(missing,collapse=', '),'\n')
